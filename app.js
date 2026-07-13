"use strict";

// ===== 0. Constants =====

const STORAGE_PREFIX = "kakekomi.";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const PREVIEW_ROW_LIMIT = 20;

// SHA-256 hashes of valid Pro unlock codes (production).
// 入力は trim + 大文字化してから照合する。コードを更新する場合は
// 新コードを大文字化した文字列のSHA-256を計算してこの配列を差し替える。
const PRO_CODE_HASHES = [
  "f6088c289e2b2c81a6399c6306be93c21bbfe0c7366a70b4d0589ee6c65c7ffc",
];

const COLUMN_ROLES = [
  { value: "ignore", label: "無視" },
  { value: "date", label: "日付" },
  { value: "desc", label: "摘要" },
  { value: "in", label: "入金額" },
  { value: "out", label: "出金額" },
  { value: "amount", label: "金額(±)" },
  { value: "balance", label: "残高" },
];

const OUTPUT_FORMATS = {
  freee: {
    label: "freee",
    headers: ["取引日", "収支区分", "金額", "取引内容"],
    buildRow: (tx) => {
      const isIncome = tx.amountIn >= tx.amountOut;
      const amount = isIncome ? tx.amountIn : tx.amountOut;
      return [tx.date, isIncome ? "収入" : "支出", String(amount), tx.desc];
    },
  },
  mf: {
    label: "マネーフォワード",
    headers: ["日付", "内容", "出金額", "入金額"],
    buildRow: (tx) => [
      tx.date,
      tx.desc,
      tx.amountOut ? String(tx.amountOut) : "",
      tx.amountIn ? String(tx.amountIn) : "",
    ],
  },
  yayoi: {
    label: "弥生",
    headers: ["日付", "入金", "出金", "摘要"],
    buildRow: (tx) => [
      tx.date,
      tx.amountIn ? String(tx.amountIn) : "",
      tx.amountOut ? String(tx.amountOut) : "",
      tx.desc,
    ],
  },
  generic: {
    label: "汎用",
    headers: ["日付", "摘要", "金額"],
    buildRow: (tx) => [tx.date, tx.desc, String(tx.amountIn - tx.amountOut)],
  },
};

const BOOTH_URL = "https://koakinaidougu.booth.pm/items/8611524"; // カケコミ変換 BOOTH商品

// ===== 1. CSV parse =====

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += text[i + 1] === "\n" ? 2 : 1;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function normalizeRowLengths(rows) {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map((r) => {
    if (r.length >= width) return r;
    const padded = r.slice();
    while (padded.length < width) padded.push("");
    return padded;
  });
}

// ===== 2. encoding =====

function decodeFileText(buffer) {
  let bytes = new Uint8Array(buffer);

  // Strip UTF-8 BOM if present
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }

  const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
  const utf8Text = utf8Decoder.decode(bytes);

  if (!utf8Text.includes("�")) {
    return utf8Text;
  }

  try {
    const sjisDecoder = new TextDecoder("shift_jis", { fatal: false });
    return sjisDecoder.decode(bytes);
  } catch (e) {
    return utf8Text;
  }
}

// ===== 3. mapping UI (state + rendering) =====

const state = {
  fileName: "",
  rows: [], // raw parsed CSV rows (all rows, including header if present)
  headerRow: true,
  columnRoles: [], // per-column role string
  amountMode: "separate", // "separate" | "signed"
  signedPositiveIsExpense: false,
  outputFormat: "freee",
  transactions: [],
  errorCount: 0,
  isPro: false,
  profiles: [],
  rules: [],
  prefs: { defaultYear: new Date().getFullYear(), lastFormat: "freee" },
};

function columnCount() {
  return state.rows.length > 0 ? state.rows[0].length : 0;
}

function guessDefaultRole(headerText) {
  const h = (headerText || "").trim();
  if (/日付|年月日|取引日|date/i.test(h)) return "date";
  if (/摘要|内容|取引内容|備考|desc/i.test(h)) return "desc";
  if (/入金|預入|お預入れ/.test(h)) return "in";
  if (/出金|引出|お引出し/.test(h)) return "out";
  if (/残高|balance/i.test(h)) return "balance";
  if (/金額|amount/i.test(h)) return "amount";
  return "ignore";
}

function initColumnRoles() {
  const count = columnCount();
  const headerCells = state.headerRow && state.rows.length > 0 ? state.rows[0] : [];
  state.columnRoles = [];
  for (let i = 0; i < count; i++) {
    state.columnRoles.push(guessDefaultRole(headerCells[i]));
  }
}

function renderMappingTable() {
  const thead = document.getElementById("mappingTableHead");
  const tbody = document.getElementById("mappingTableBody");
  thead.textContent = "";
  tbody.textContent = "";

  const count = columnCount();
  const headerRow = document.createElement("tr");
  for (let c = 0; c < count; c++) {
    const th = document.createElement("th");
    const select = document.createElement("select");
    select.dataset.colIndex = String(c);
    select.className = "col-role-select";
    COLUMN_ROLES.forEach((role) => {
      const opt = document.createElement("option");
      opt.value = role.value;
      opt.textContent = role.label;
      if (state.columnRoles[c] === role.value) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      state.columnRoles[c] = select.value;
    });
    th.appendChild(select);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);

  const previewRows = state.rows.slice(0, PREVIEW_ROW_LIMIT);
  previewRows.forEach((row) => {
    const tr = document.createElement("tr");
    for (let c = 0; c < count; c++) {
      const td = document.createElement("td");
      td.textContent = row[c] !== undefined ? row[c] : "";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
}

function updateAmountModeUI() {
  const wrap = document.getElementById("signedPositiveIsExpenseWrap");
  wrap.style.display = state.amountMode === "signed" ? "inline-flex" : "none";
}

// ===== 4. transform =====

function normalizeDate(raw, defaultYear) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let m = s.match(/^(?:令和|[Rr令])\s*(\d{1,2})[.\/年](\d{1,2})[.\/月](\d{1,2})日?$/);
  if (m) {
    const year = 2018 + parseInt(m[1], 10);
    return formatDate(year, parseInt(m[2], 10), parseInt(m[3], 10));
  }

  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    return formatDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  }

  m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    return formatDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  }

  m = s.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (m) {
    return formatDate(defaultYear, parseInt(m[1], 10), parseInt(m[2], 10));
  }

  return null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isValidDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function formatDate(y, m, d) {
  if (!isValidDate(y, m, d)) return null;
  return `${y}/${pad2(m)}/${pad2(d)}`;
}

function normalizeAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[¥￥,，、\s円]/g, "");   // 半角/全角カンマ・読点・空白・円 を除去
  let negative = false;
  const paren = s.match(/^\((.*)\)$/);      // (1000) を負数扱い
  if (paren) { negative = true; s = paren[1]; }
  if (/-$/.test(s)) { negative = true; s = s.replace(/-+$/, ""); } // 1000- を負数扱い
  if (s === "" || s === "-") return null;
  const num = Number(s);
  if (Number.isNaN(num)) return null;
  return Math.round(negative ? -Math.abs(num) : num);
}

function applyRules(desc, rules) {
  let result = desc;
  for (const rule of rules) {
    if (!rule.search) continue;
    if (result.includes(rule.search)) {
      if (rule.replace) {
        result = result.split(rule.search).join(rule.replace);
      }
      if (rule.account) {
        result = `${result} 【${rule.account}】`;
      }
    }
  }
  return result;
}

function buildTransactions() {
  const dataRows = state.headerRow ? state.rows.slice(1) : state.rows;
  const transactions = [];
  let errorCount = 0;
  const activeRules = state.isPro ? state.rules : [];

  dataRows.forEach((row) => {
    let dateRaw = "";
    let desc = "";
    let inAmt = 0;
    let outAmt = 0;

    state.columnRoles.forEach((role, idx) => {
      const cell = row[idx] !== undefined ? row[idx] : "";
      if (role === "date") {
        dateRaw = cell;
      } else if (role === "desc") {
        desc = desc ? `${desc} ${cell}` : cell;
      } else if (role === "in") {
        const amt = normalizeAmount(cell);
        if (amt != null) inAmt += amt;
      } else if (role === "out") {
        const amt = normalizeAmount(cell);
        if (amt != null) outAmt += amt;
      } else if (role === "amount" && state.amountMode === "signed") {
        const amt = normalizeAmount(cell);
        if (amt != null) {
          if (state.signedPositiveIsExpense) {
            if (amt >= 0) outAmt += amt;
            else inAmt += -amt;
          } else if (amt >= 0) {
            inAmt += amt;
          } else {
            outAmt += -amt;
          }
        }
      }
    });

    const date = normalizeDate(dateRaw, state.prefs.defaultYear);
    if (date === null) errorCount += 1;

    transactions.push({
      date,
      desc: applyRules(desc, activeRules),
      amountIn: inAmt,
      amountOut: outAmt,
      dateError: date === null,
    });
  });

  state.transactions = transactions;
  state.errorCount = errorCount;
}

// ===== 5. output templates =====

function csvField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/["\r\n,]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCSVText(headers, rows) {
  const lines = [headers.map(csvField).join(",")];
  rows.forEach((row) => lines.push(row.map(csvField).join(",")));
  return lines.join("\r\n");
}

function buildOutput() {
  const format = OUTPUT_FORMATS[state.outputFormat];
  const validTx = state.transactions.filter((tx) => !tx.dateError);
  const outRows = validTx.map((tx) => format.buildRow(tx));
  return { headers: format.headers, rows: outRows };
}

function downloadCSV(filename, text) {
  const bom = "\uFEFF";
  const blob = new Blob([bom + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseFileName(name) {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

// ===== 6. storage =====

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    try {
      localStorage.removeItem(STORAGE_PREFIX + key);
    } catch (e2) {
      /* localStorage unavailable, ignore */
    }
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    /* storage full or unavailable, ignore */
  }
}

function loadAllState() {
  loadJSON("version", 1);
  state.profiles = loadJSON("profiles", []);
  state.rules = loadJSON("rules", []);
  state.prefs = loadJSON("prefs", { defaultYear: new Date().getFullYear(), lastFormat: "freee" });
  state.outputFormat = state.prefs.lastFormat || "freee";

  const pro = loadJSON("pro", null);
  state.isPro = !!(pro && pro.activated && PRO_CODE_HASHES.includes(pro.codeHash));
}

function findMatchingProfile() {
  if (state.rows.length === 0) return null;
  const fingerprint = state.rows[0].join(",");
  const count = columnCount();
  return (
    state.profiles.find(
      (p) => p.columns.length === count && p.headerFingerprint === fingerprint
    ) || null
  );
}

function applyProfile(profile) {
  state.headerRow = profile.headerRow;
  state.columnRoles = profile.columns.slice();
  state.amountMode = profile.amountMode;
  state.signedPositiveIsExpense = !!profile.signedPositiveIsExpense;
  state.outputFormat = profile.defaultFormat;

  document.getElementById("headerRowCheck").checked = state.headerRow;
  document.querySelector(`input[name="amountMode"][value="${state.amountMode}"]`).checked = true;
  document.getElementById("signedPositiveIsExpense").checked = state.signedPositiveIsExpense;
  const formatRadio = document.querySelector(`input[name="outputFormat"][value="${state.outputFormat}"]`);
  if (formatRadio) formatRadio.checked = true;
  updateAmountModeUI();
  renderMappingTable();
}

// ===== 7. pro/license =====

async function sha256Hex(text) {
  const enc = new TextEncoder();
  const data = enc.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function setProUI() {
  document.getElementById("proBadge").classList.toggle("hidden", !state.isPro);
  document.getElementById("proPromo").classList.toggle("hidden", state.isPro);
  document.getElementById("proActivated").classList.toggle("hidden", !state.isPro);
  document.getElementById("proActivateForm").classList.toggle("hidden", state.isPro);
  document.querySelectorAll(".pro-only-section").forEach((el) => el.classList.toggle("hidden", !state.isPro));
  document.getElementById("rulesLockedSection").classList.toggle("hidden", state.isPro);
}

async function activatePro(code) {
  const messageEl = document.getElementById("proCodeMessage");
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) {
    messageEl.textContent = "コードを入力してください。";
    messageEl.className = "form-message error";
    return;
  }
  const hash = await sha256Hex(trimmed);
  if (PRO_CODE_HASHES.includes(hash)) {
    state.isPro = true;
    saveJSON("pro", { activated: true, codeHash: hash, activatedAt: new Date().toISOString() });
    messageEl.textContent = "Pro版が有効になりました。";
    messageEl.className = "form-message success";
    setProUI();
    renderProfileList();
    renderRulesTable();
  } else {
    messageEl.textContent = "コードが正しくありません。";
    messageEl.className = "form-message error";
  }
  messageEl.classList.remove("hidden");
}

// ===== 8. rules (Pro) =====

function renderRulesTable() {
  const tbody = document.getElementById("rulesTableBody");
  tbody.textContent = "";
  state.rules.forEach((rule) => {
    const tr = document.createElement("tr");

    const searchTd = document.createElement("td");
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.value = rule.search || "";
    searchInput.addEventListener("input", () => {
      rule.search = searchInput.value;
      saveJSON("rules", state.rules);
    });
    searchTd.appendChild(searchInput);

    const replaceTd = document.createElement("td");
    const replaceInput = document.createElement("input");
    replaceInput.type = "text";
    replaceInput.value = rule.replace || "";
    replaceInput.addEventListener("input", () => {
      rule.replace = replaceInput.value;
      saveJSON("rules", state.rules);
    });
    replaceTd.appendChild(replaceInput);

    const accountTd = document.createElement("td");
    const accountInput = document.createElement("input");
    accountInput.type = "text";
    accountInput.value = rule.account || "";
    accountInput.addEventListener("input", () => {
      rule.account = accountInput.value;
      saveJSON("rules", state.rules);
    });
    accountTd.appendChild(accountInput);

    const deleteTd = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-small btn-ghost";
    deleteBtn.textContent = "削除";
    deleteBtn.addEventListener("click", () => {
      state.rules = state.rules.filter((r) => r.id !== rule.id);
      saveJSON("rules", state.rules);
      renderRulesTable();
    });
    deleteTd.appendChild(deleteBtn);

    tr.append(searchTd, replaceTd, accountTd, deleteTd);
    tbody.appendChild(tr);
  });
}

function addRule() {
  state.rules.push({ id: `r_${Date.now()}`, search: "", replace: "", account: "" });
  saveJSON("rules", state.rules);
  renderRulesTable();
}

// ===== profiles UI =====

function renderProfileSelect() {
  const select = document.getElementById("savedProfileSelect");
  select.textContent = "";
  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "選択してください";
  select.appendChild(emptyOpt);
  state.profiles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
}

function renderProfileList() {
  const list = document.getElementById("profileList");
  const emptyText = document.getElementById("profileListEmpty");
  list.textContent = "";
  emptyText.classList.toggle("hidden", state.profiles.length > 0);

  state.profiles.forEach((p) => {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.name;
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-small btn-ghost";
    deleteBtn.textContent = "削除";
    deleteBtn.addEventListener("click", () => {
      state.profiles = state.profiles.filter((x) => x.id !== p.id);
      saveJSON("profiles", state.profiles);
      renderProfileList();
      renderProfileSelect();
    });
    li.append(nameSpan, deleteBtn);
    list.appendChild(li);
  });
}

function saveCurrentProfile(name) {
  if (!state.isPro && state.profiles.length >= 1) {
    openModal("settingsModal");
    const msg = document.getElementById("proCodeMessage");
    msg.textContent = "設定の保存は無料版では1件までです。Pro版で無制限に保存できます。";
    msg.className = "form-message error";
    msg.classList.remove("hidden");
    return false;
  }

  const profile = {
    id: `p_${Date.now()}`,
    name: name || `設定 ${state.profiles.length + 1}`,
    headerRow: state.headerRow,
    columns: state.columnRoles.slice(),
    amountMode: state.amountMode,
    signedPositiveIsExpense: state.signedPositiveIsExpense,
    defaultFormat: state.outputFormat,
    headerFingerprint: state.rows.length > 0 ? state.rows[0].join(",") : "",
    createdAt: Date.now(),
  };
  state.profiles.push(profile);
  saveJSON("profiles", state.profiles);
  renderProfileList();
  renderProfileSelect();
  return true;
}

// ===== export / import =====

function exportSettings() {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: state.profiles,
    rules: state.rules,
    prefs: state.prefs,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "kakekomi-settings.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importSettings(file) {
  const messageEl = document.getElementById("importMessage");
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      state.profiles = Array.isArray(data.profiles) ? data.profiles : [];
      state.rules = Array.isArray(data.rules) ? data.rules : [];
      state.prefs = data.prefs && typeof data.prefs === "object" ? data.prefs : state.prefs;
      saveJSON("profiles", state.profiles);
      saveJSON("rules", state.rules);
      saveJSON("prefs", state.prefs);
      renderProfileList();
      renderProfileSelect();
      renderRulesTable();
      messageEl.textContent = "設定を読み込みました。";
      messageEl.className = "form-message success";
    } catch (e) {
      messageEl.textContent = "ファイルの読み込みに失敗しました。正しい設定ファイルを選択してください。";
      messageEl.className = "form-message error";
    }
    messageEl.classList.remove("hidden");
  };
  reader.readAsText(file);
}

function resetAllData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  keys.forEach((k) => localStorage.removeItem(k));

  state.profiles = [];
  state.rules = [];
  state.isPro = false;
  state.prefs = { defaultYear: new Date().getFullYear(), lastFormat: "freee" };

  renderProfileList();
  renderProfileSelect();
  renderRulesTable();
  setProUI();
}

// ===== 9. main / events =====

function showError(message) {
  const el = document.getElementById("fileError");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function handleFile(file) {
  showError("");

  if (!file) return;

  if (file.size === 0) {
    showError("ファイルが空です。内容のあるCSVファイルを選択してください。");
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    showError("10MB以下のファイルを指定してください。");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = decodeFileText(reader.result);
      const parsed = normalizeRowLengths(parseCSV(text));
      if (parsed.length === 0) {
        showError("ファイルが空です。内容のあるCSVファイルを選択してください。");
        return;
      }
      state.fileName = file.name;
      state.rows = parsed;
      state.headerRow = document.getElementById("headerRowCheck").checked;
      initColumnRoles();
      renderMappingTable();
      updateAmountModeUI();

      const match = findMatchingProfile();
      const banner = document.getElementById("profileBanner");
      if (match) {
        document.getElementById("profileBannerText").textContent = `前回の設定『${match.name}』を適用しますか？`;
        banner.dataset.profileId = match.id;
        banner.classList.remove("hidden");
      } else {
        banner.classList.add("hidden");
      }

      document.getElementById("inputZone").classList.add("hidden");
      document.getElementById("mappingZone").classList.remove("hidden");
      document.getElementById("resultZone").classList.add("hidden");
    } catch (e) {
      showError("ファイルの読み込みに失敗しました。別のCSVファイルでお試しください。");
    }
  };
  reader.onerror = () => {
    showError("ファイルの読み込みに失敗しました。別のCSVファイルでお試しください。");
  };
  reader.readAsArrayBuffer(file);
}

function renderResult() {
  buildTransactions();
  const { headers, rows } = buildOutput();

  const summaryEl = document.getElementById("resultSummary");
  summaryEl.textContent = `変換結果: ${state.transactions.length}行${
    state.errorCount > 0 ? `（うち日付エラー ${state.errorCount}行）` : ""
  }`;

  const warningEl = document.getElementById("resultWarning");
  if (state.errorCount > 0) {
    warningEl.textContent = `日付を認識できなかった行が${state.errorCount}件あります。ダウンロードには含まれません。`;
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }

  document.getElementById("yayoiNote").classList.toggle("hidden", state.outputFormat !== "yayoi");

  const thead = document.getElementById("resultTableHead");
  const tbody = document.getElementById("resultTableBody");
  thead.textContent = "";
  tbody.textContent = "";

  const headRow = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  rows.slice(0, PREVIEW_ROW_LIMIT).forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  // Also show error rows (original data) for visibility, highlighted
  const dataRows = state.headerRow ? state.rows.slice(1) : state.rows;
  state.transactions.forEach((tx, idx) => {
    if (!tx.dateError) return;
    if (tbody.children.length >= PREVIEW_ROW_LIMIT * 2) return;
    const tr = document.createElement("tr");
    tr.className = "row-error";
    const original = dataRows[idx] || [];
    headers.forEach((_, colIdx) => {
      const td = document.createElement("td");
      td.textContent = colIdx === 0 ? `(日付不明) ${original.join(" / ")}` : "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

function setupDropZone() {
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");

  dropZone.addEventListener("click", (e) => {
    if (e.target.closest("label")) return;
    fileInput.click();
  });
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
    });
  });
  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

function setupMappingEvents() {
  document.getElementById("headerRowCheck").addEventListener("change", (e) => {
    state.headerRow = e.target.checked;
    initColumnRoles();
    renderMappingTable();
  });

  document.querySelectorAll('input[name="amountMode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.amountMode = e.target.value;
      updateAmountModeUI();
    });
  });

  document.getElementById("signedPositiveIsExpense").addEventListener("change", (e) => {
    state.signedPositiveIsExpense = e.target.checked;
  });

  document.querySelectorAll('input[name="outputFormat"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.outputFormat = e.target.value;
      state.prefs.lastFormat = e.target.value;
      saveJSON("prefs", state.prefs);
    });
  });

  document.getElementById("savedProfileSelect").addEventListener("change", (e) => {
    const profile = state.profiles.find((p) => p.id === e.target.value);
    if (profile) applyProfile(profile);
  });

  document.getElementById("applyProfileBtn").addEventListener("click", () => {
    const banner = document.getElementById("profileBanner");
    const profile = state.profiles.find((p) => p.id === banner.dataset.profileId);
    if (profile) applyProfile(profile);
    banner.classList.add("hidden");
  });

  document.getElementById("dismissProfileBtn").addEventListener("click", () => {
    document.getElementById("profileBanner").classList.add("hidden");
  });

  document.getElementById("saveProfileBtn").addEventListener("click", () => {
    const nameInput = document.getElementById("profileNameInput");
    const ok = saveCurrentProfile(nameInput.value.trim());
    if (ok) nameInput.value = "";
  });

  document.getElementById("goToResultBtn").addEventListener("click", () => {
    renderResult();
    document.getElementById("mappingZone").classList.add("hidden");
    document.getElementById("resultZone").classList.remove("hidden");
  });

  document.getElementById("backToMappingBtn").addEventListener("click", () => {
    document.getElementById("resultZone").classList.add("hidden");
    document.getElementById("mappingZone").classList.remove("hidden");
  });

  document.getElementById("downloadBtn").addEventListener("click", () => {
    const { headers, rows } = buildOutput();
    const text = rowsToCSVText(headers, rows);
    const formatLabel = OUTPUT_FORMATS[state.outputFormat].label;
    const filename = `変換済_${baseFileName(state.fileName)}_${formatLabel}.csv`;
    downloadCSV(filename, text);
  });
}

function setupSettingsEvents() {
  document.getElementById("openSettingsBtn").addEventListener("click", () => {
    renderProfileList();
    renderRulesTable();
    openModal("settingsModal");
  });
  document.getElementById("closeSettingsBtn").addEventListener("click", () => closeModal("settingsModal"));

  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.add("hidden");
    });
  });
  document.querySelectorAll(".modal-close-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.target.closest(".modal-overlay").classList.add("hidden");
    });
  });

  document.getElementById("activateProBtn").addEventListener("click", () => {
    const input = document.getElementById("proCodeInput");
    activatePro(input.value);
  });
  document.getElementById("proCodeInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); activatePro(document.getElementById("proCodeInput").value); }
  });

  document.getElementById("addRuleBtn").addEventListener("click", addRule);

  document.getElementById("exportBtn").addEventListener("click", exportSettings);
  document.getElementById("importFileInput").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importSettings(file);
  });

  document.getElementById("resetDataBtn").addEventListener("click", () => {
    if (window.confirm("保存されているすべての設定を消去します。よろしいですか？")) {
      resetAllData();
    }
  });

  document.getElementById("tokushoLink").addEventListener("click", (e) => {
    e.preventDefault();
    openModal("tokushoModal");
  });
  document.getElementById("privacyLink").addEventListener("click", (e) => {
    e.preventDefault();
    openModal("privacyModal");
  });
  document.getElementById("operatorInfoBtn").addEventListener("click", (e) => {
    e.preventDefault();
    openModal("operatorModal");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".modal-overlay:not(.hidden)").forEach((ov) => ov.classList.add("hidden"));
  });
}

function init() {
  loadAllState();

  document.getElementById("boothLink").href = BOOTH_URL;
  document.getElementById("tokushoBoothLink").href = BOOTH_URL;

  const formatRadio = document.querySelector(`input[name="outputFormat"][value="${state.outputFormat}"]`);
  if (formatRadio) formatRadio.checked = true;

  setProUI();
  renderProfileSelect();
  setupDropZone();
  setupMappingEvents();
  setupSettingsEvents();
}

document.addEventListener("DOMContentLoaded", init);
