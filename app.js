const STORAGE_KEY = "chemo-lab-tracker-v1";
const PANEL_STATE_KEY = "chemo-lab-tracker-panels-v1";
const FAMILY_CODE_KEY = "chemo-lab-tracker-family-code";

const firebaseConfig = {
  apiKey: "AIzaSyA_S8fS3qys5JIKrNjwgdJYVZuU-_bRDoE",
  authDomain: "chemotherapy-record.firebaseapp.com",
  projectId: "chemotherapy-record",
  storageBucket: "chemotherapy-record.firebasestorage.app",
  messagingSenderId: "651734889686",
  appId: "1:651734889686:web:3d44208ea32f2fee878577",
};

let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let cloudUser = null;
let cloudSaveTimer = null;
let loadingCloud = false;

const defaultMetrics = [
  { name: "白细胞 WBC", unit: "10^9/L", min: "", max: "" },
  { name: "中性粒细胞 NEUT%", unit: "%", min: "", max: "" },
  { name: "血红蛋白 HGB", unit: "g/L", min: "", max: "" },
  { name: "血小板 PLT", unit: "10^9/L", min: "", max: "" },
  { name: "红细胞 RBC", unit: "10^12/L", min: "", max: "" },
  { name: "CEA", unit: "ng/mL", min: "", max: "" },
  { name: "CA19-9", unit: "U/mL", min: "", max: "" },
  { name: "CA125", unit: "U/mL", min: "", max: "" },
  { name: "AFP", unit: "ng/mL", min: "", max: "" },
  { name: "ALT", unit: "U/L", min: "", max: "" },
  { name: "AST", unit: "U/L", min: "", max: "" },
  { name: "ALP", unit: "U/L", min: "", max: "" },
  { name: "GGT", unit: "U/L", min: "", max: "" },
  { name: "总胆红素 TBIL", unit: "umol/L", min: "", max: "" },
  { name: "白蛋白 ALB", unit: "g/L", min: "", max: "" },
  { name: "肌酐 CREA", unit: "umol/L", min: "", max: "" },
  { name: "尿素 UREA", unit: "mmol/L", min: "", max: "" },
  { name: "尿酸 UA", unit: "umol/L", min: "", max: "" },
  { name: "eGFR", unit: "", min: "", max: "" },
  { name: "钾 K", unit: "mmol/L", min: "", max: "" },
  { name: "钠 Na", unit: "mmol/L", min: "", max: "" },
  { name: "氯 Cl", unit: "mmol/L", min: "", max: "" },
];

const metricAliases = {
  "白细胞": "白细胞 WBC",
  "白细胞计数": "白细胞 WBC",
  "WBC": "白细胞 WBC",
  "中性粒细胞百分比": "中性粒细胞 NEUT%",
  "NEUT%": "中性粒细胞 NEUT%",
  "血红蛋白": "血红蛋白 HGB",
  "HGB": "血红蛋白 HGB",
  "血小板": "血小板 PLT",
  "PLT": "血小板 PLT",
  "红细胞": "红细胞 RBC",
  "RBC": "红细胞 RBC",
  "癌胚抗原": "CEA",
  "CEA": "CEA",
  "糖类抗原19-9": "CA19-9",
  "CA19-9": "CA19-9",
  "甲胎蛋白": "AFP",
  "AFP": "AFP",
  "谷丙转氨酶": "ALT",
  "ALT": "ALT",
  "谷草转氨酶": "AST",
  "AST": "AST",
  "肌酐": "肌酐 CREA",
  "CREA": "肌酐 CREA",
  "尿素": "尿素 UREA",
  "UREA": "尿素 UREA",
};

let state = loadState();
let draftRows = [];

const el = (id) => document.getElementById(id);

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    return normalizeState(saved);
  } catch {
    return normalizeState({});
  }
}

function normalizeState(saved) {
  const records = Array.isArray(saved.records) ? saved.records : [];
  const events = Array.isArray(saved.events) ? saved.events.map(normalizeEvent) : [];
  const metrics = Array.isArray(saved.metrics) ? saved.metrics : defaultMetrics;
  const categories = Array.isArray(saved.categories) ? saved.categories.map(normalizeCategory).filter((item) => item.name) : [];
  const recordMetrics = records.flatMap((record) => record.rows?.map((row) => ({
    name: row.metric,
    unit: row.unit || "",
    min: parseRange(row.range)?.min ?? "",
    max: parseRange(row.range)?.max ?? "",
  })) || []);
  return {
    records,
    events,
    metrics: uniqueMetricConfigs([...metrics, ...recordMetrics]),
    categories,
  };
}

function normalizeEvent(event) {
  return {
    id: event.id || crypto.randomUUID(),
    date: event.date || today(),
    time: event.time || "",
    type: event.type || (event.text?.includes("化疗") ? "化疗" : "事件"),
    cycle: event.cycle || "",
    text: event.text || "",
    drugs: event.drugs || "",
    note: event.note || "",
  };
}

function normalizeCategory(category) {
  return {
    id: category.id || crypto.randomUUID(),
    name: String(category.name || "").trim(),
    metrics: [...new Set((category.metrics || []).map((metric) => normalizeMetric(metric)).filter(Boolean))],
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleCloudSave();
}

function sanitizeFamilyCode(value) {
  return String(value || "default-family")
    .trim()
    .replace(/[\/\\#?[\]]/g, "-")
    .slice(0, 80) || "default-family";
}

function getFamilyCode() {
  return sanitizeFamilyCode(el("familyCode")?.value || localStorage.getItem(FAMILY_CODE_KEY) || "default-family");
}

function cloudDocRef() {
  if (!firebaseDb || !cloudUser) return null;
  return firebaseDb.collection("families").doc(getFamilyCode()).collection("app").doc("main");
}

function updateCloudStatus(message) {
  const status = el("cloudStatus");
  if (status) status.textContent = message;
}

function getFirebaseAuthErrorMessage(error, actionLabel) {
  const code = error?.code || "";
  const messages = {
    "auth/invalid-credential": "邮箱或密码不正确，请重新检查后再试。",
    "auth/user-not-found": "这个邮箱还没有注册，请先点“注册”。",
    "auth/wrong-password": "密码不正确，请重新输入。",
    "auth/invalid-email": "邮箱格式不正确，请检查是否输错。",
    "auth/missing-email": "请输入邮箱。",
    "auth/missing-password": "请输入密码。",
    "auth/weak-password": "密码太短，请设置至少 6 位密码。",
    "auth/email-already-in-use": "这个邮箱已经注册过了，请直接点“登录”。",
    "auth/too-many-requests": "尝试次数太多，Firebase 暂时限制了登录，请稍后再试。",
    "auth/network-request-failed": "网络连接失败，请检查网络后再试。",
    "auth/operation-not-allowed": "Firebase 后台还没有启用“电子邮件地址/密码”登录方式。",
    "auth/unauthorized-domain": "当前网页地址未被 Firebase 授权，请把网页部署到 Firebase Hosting 后再登录。",
  };
  return `${actionLabel}失败：${messages[code] || error?.message || "未知错误，请稍后再试。"}`;
}

function showFirebaseAuthError(error, actionLabel) {
  const message = getFirebaseAuthErrorMessage(error, actionLabel);
  toast(message);
  updateCloudStatus(message);
}

function scheduleCloudSave() {
  if (!firebaseDb || !cloudUser || loadingCloud) return;
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(saveCloudState, 650);
}

async function saveCloudState() {
  const ref = cloudDocRef();
  if (!ref) return;
  try {
    localStorage.setItem(FAMILY_CODE_KEY, getFamilyCode());
    await ref.set({
      app: "chemo-lab-tracker",
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: cloudUser.email || cloudUser.uid,
      data: normalizeState(state),
    }, { merge: true });
    updateCloudStatus(`已同步到云端：${getFamilyCode()}（${cloudUser.email || "已登录"}）`);
  } catch (error) {
    updateCloudStatus(`云端同步失败：${error.message}`);
  }
}

async function loadCloudState() {
  const ref = cloudDocRef();
  if (!ref) return;
  loadingCloud = true;
  try {
    localStorage.setItem(FAMILY_CODE_KEY, getFamilyCode());
    updateCloudStatus("正在读取云端数据...");
    const snapshot = await ref.get();
    if (snapshot.exists && snapshot.data()?.data) {
      state = normalizeState(snapshot.data().data);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      draftRows = [];
      renderDraft();
      renderAll();
      updateCloudStatus(`已加载云端数据：${getFamilyCode()}（${cloudUser.email || "已登录"}）`);
    } else {
      updateCloudStatus("云端暂无数据，正在上传当前本地数据...");
      loadingCloud = false;
      await saveCloudState();
      return;
    }
  } catch (error) {
    updateCloudStatus(`读取云端失败：${error.message}`);
  } finally {
    loadingCloud = false;
  }
}

function initFirebase() {
  if (!window.firebase) {
    updateCloudStatus("Firebase SDK 未加载；当前仅本地保存。");
    return;
  }
  try {
    firebaseApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
    firebaseAuth = firebase.auth();
    firebaseDb = firebase.firestore();
    firebaseAuth.onAuthStateChanged(async (user) => {
      cloudUser = user;
      if (user) {
        await loadCloudState();
      } else {
        updateCloudStatus("未登录时仅保存在当前浏览器本地。");
      }
    });
  } catch (error) {
    updateCloudStatus(`Firebase 初始化失败：${error.message}`);
  }
}

async function signInCloud() {
  if (!firebaseAuth) return toast("Firebase 未初始化");
  const email = el("cloudEmail").value.trim();
  const password = el("cloudPassword").value;
  if (!email || !password) return toast("请输入邮箱和密码");
  try {
    localStorage.setItem(FAMILY_CODE_KEY, getFamilyCode());
    await firebaseAuth.signInWithEmailAndPassword(email, password);
    toast("已登录");
  } catch (error) {
    showFirebaseAuthError(error, "登录");
  }
}

async function signUpCloud() {
  if (!firebaseAuth) return toast("Firebase 未初始化");
  const email = el("cloudEmail").value.trim();
  const password = el("cloudPassword").value;
  if (!email || !password) return toast("请输入邮箱和密码");
  try {
    localStorage.setItem(FAMILY_CODE_KEY, getFamilyCode());
    await firebaseAuth.createUserWithEmailAndPassword(email, password);
    toast("已注册并登录");
  } catch (error) {
    showFirebaseAuthError(error, "注册");
  }
}

async function signOutCloud() {
  if (!firebaseAuth) return;
  await firebaseAuth.signOut();
  toast("已退出");
}

function loadPanelState() {
  try {
    return JSON.parse(localStorage.getItem(PANEL_STATE_KEY)) || {};
  } catch {
    return {};
  }
}

function savePanelState(panelState) {
  localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(panelState));
}

function uniqueMetricConfigs(metrics) {
  const map = new Map();
  metrics.forEach((item) => {
    const config = normalizeMetricConfig(item);
    if (!config.name) return;
    const existing = map.get(config.name);
    map.set(config.name, {
      name: config.name,
      unit: config.unit || existing?.unit || "",
      min: config.min !== "" ? config.min : existing?.min || "",
      max: config.max !== "" ? config.max : existing?.max || "",
    });
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function normalizeMetricConfig(item) {
  if (typeof item === "string") {
    return { name: normalizeMetric(item), unit: "", min: "", max: "" };
  }
  const range = parseRange(item.range || "");
  return {
    name: normalizeMetric(String(item.name || item.metric || "")),
    unit: String(item.unit || ""),
    min: cleanBound(item.min ?? range?.min ?? ""),
    max: cleanBound(item.max ?? range?.max ?? ""),
  };
}

function cleanBound(value) {
  const text = String(value ?? "").trim();
  return text === "" ? "" : text;
}

function metricNames() {
  return (state.metrics || []).map((item) => normalizeMetricConfig(item).name).filter(Boolean);
}

function metricConfig(name) {
  const normalized = normalizeMetric(name);
  return (state.metrics || []).map(normalizeMetricConfig).find((item) => item.name === normalized) || {
    name: normalized,
    unit: "",
    min: "",
    max: "",
  };
}

function formatRangeFromConfig(config) {
  if (!config) return "";
  if (config.min === "" && config.max === "") return "";
  if (config.min !== "" && config.max !== "") return `${config.min}-${config.max}`;
  if (config.min !== "") return `≥${config.min}`;
  return `≤${config.max}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function toast(message) {
  const box = el("toast");
  box.textContent = message;
  box.classList.add("show");
  window.setTimeout(() => box.classList.remove("show"), 1800);
}

function normalizeMetric(name) {
  const clean = name.replace(/[：:]/g, "").trim();
  return metricAliases[clean] || clean;
}

function parseRange(range) {
  if (!range) return null;
  const match = range.match(/(-?\d+(?:\.\d+)?)\s*[-~－—]\s*(-?\d+(?:\.\d+)?)/);
  if (match) return { min: String(match[1]), max: String(match[2]) };
  const minMatch = range.match(/[≥>=]\s*(-?\d+(?:\.\d+)?)/);
  if (minMatch) return { min: String(minMatch[1]), max: "" };
  const maxMatch = range.match(/[≤<=]\s*(-?\d+(?:\.\d+)?)/);
  if (maxMatch) return { min: "", max: String(maxMatch[1]) };
  return null;
}

function statusForValue(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) return "未标注";
  if (max !== "" && number > Number(max)) return "偏高";
  if (min !== "" && number < Number(min)) return "偏低";
  if (min === "" && max === "") return "未标注";
  return "正常";
}

function applyMetricDefaults(row) {
  const config = metricConfig(row.metric);
  const rowRange = parseRange(row.range || "");
  const min = config.min !== "" ? config.min : rowRange?.min ?? "";
  const max = config.max !== "" ? config.max : rowRange?.max ?? "";
  return {
    ...row,
    metric: config.name,
    unit: row.unit || config.unit,
    range: row.range || formatRangeFromConfig(config),
    status: statusForValue(row.value, min, max),
  };
}

function addDraftRow(row = {}) {
  const fallbackMetric = metricNames()[0] || "";
  draftRows.push(applyMetricDefaults({
    metric: row.metric || fallbackMetric,
    value: row.value || "",
    unit: row.unit || "",
    range: row.range || "",
    status: row.status || "未标注",
  }));
  renderDraft();
}

function addMetricsToDraft(metrics) {
  const existing = new Set(draftRows.map((row) => normalizeMetric(row.metric)));
  const additions = metrics.filter((metric) => !existing.has(metric));
  if (!additions.length) {
    toast("选中的指标都已在本次记录中");
    return;
  }
  additions.forEach((metric) => {
    draftRows.push(applyMetricDefaults({
      metric,
      value: "",
      unit: "",
      range: "",
      status: "未标注",
    }));
  });
  renderDraft();
  toast(`已加入 ${additions.length} 个指标`);
}

function addMetricToDraft(metric) {
  const normalized = normalizeMetric(metric);
  if (!normalized) {
    toast("请先选择指标");
    return;
  }
  if (draftRows.some((row) => normalizeMetric(row.metric) === normalized)) {
    toast("本次记录里已经有这个指标");
    return;
  }
  addDraftRow({ metric: normalized });
  toast("已加入本次记录");
}

function addAllMetricsToDraft() {
  const existing = new Set(draftRows.map((row) => normalizeMetric(row.metric)));
  const additions = metricLibraryOptions().filter((metric) => !existing.has(metric));
  if (!additions.length) {
    toast("指标库里的指标都已在本次记录中");
    return;
  }
  additions.forEach((metric) => {
    draftRows.push(applyMetricDefaults({
      metric,
      value: "",
      unit: "",
      range: "",
      status: "未标注",
    }));
  });
  renderDraft();
  toast(`已加入 ${additions.length} 个指标`);
}

function addSelectedMetricsToDraft() {
  const checked = selectedMetricNames();
  if (!checked.length) {
    toast("请先勾选要录入的指标");
    return;
  }
  addMetricsToDraft(checked);
}

function renderDraft() {
  const body = el("draftBody");
  body.innerHTML = "";
  if (!draftRows.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty-row">暂无识别结果</td></tr>`;
    return;
  }
  const metricChoices = metricLibraryOptions();
  draftRows.forEach((row, index) => {
    const rowWithDefaults = applyMetricDefaults(row);
    draftRows[index] = rowWithDefaults;
    const metric = normalizeMetric(rowWithDefaults.metric);
    if (metric && !metricChoices.includes(metric)) metricChoices.push(metric);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <select data-field="metric" data-index="${index}">
          <option value="">选择指标</option>
          ${metricChoices.map((item) => `<option value="${escapeHtml(item)}" ${item === metric ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}
        </select>
      </td>
      <td><input value="${escapeHtml(rowWithDefaults.value)}" data-field="value" data-index="${index}" placeholder="填结果" /></td>
      <td><span class="readonly-cell">${escapeHtml(rowWithDefaults.unit || "-")}</span></td>
      <td><span class="readonly-cell">${escapeHtml(rowWithDefaults.range || "-")}</span></td>
      <td><span class="${statusClass(rowWithDefaults.status)}">${escapeHtml(rowWithDefaults.status)}</span></td>
      <td><button class="icon-btn" data-remove="${index}" title="删除">删除</button></td>
    `;
    body.appendChild(tr);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusClass(status) {
  if (status === "偏高") return "status-high";
  if (status === "偏低") return "status-low";
  if (status === "正常") return "status-normal";
  return "status-warn";
}

function saveDraft() {
  const date = el("testDate").value || today();
  const type = el("reportType").value;
  const rows = draftRows
    .map((row) => applyMetricDefaults(row))
    .map((row) => {
      const config = metricConfig(row.metric);
      const rowRange = parseRange(row.range || "");
      const min = config.min !== "" ? config.min : rowRange?.min ?? "";
      const max = config.max !== "" ? config.max : rowRange?.max ?? "";
      const range = formatRangeFromConfig(config) || row.range;
      return {
        ...row,
        metric: normalizeMetric(row.metric),
        value: Number(row.value),
        unit: config.unit || row.unit,
        range,
        status: statusForValue(row.value, min, max),
      };
    })
    .filter((row) => row.metric && !Number.isNaN(row.value));

  if (!rows.length) {
    toast("请先添加至少一个有效指标");
    return;
  }

  state.records.push({
    id: crypto.randomUUID(),
    date,
    type,
    rows,
    createdAt: new Date().toISOString(),
  });
  state.metrics = uniqueMetricConfigs([...state.metrics, ...rows.map((row) => ({
    name: row.metric,
    unit: row.unit,
    range: row.range,
  }))]);
  state.records.sort((a, b) => a.date.localeCompare(b.date));
  saveState();
  draftRows = draftRows.map((row) => applyMetricDefaults({ ...row, value: "" }));
  renderDraft();
  renderAll();
  toast("已保存本次记录");
}

function metricOptions() {
  const set = new Set();
  state.records.forEach((record) => record.rows.forEach((row) => set.add(row.metric)));
  return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function metricLibraryOptions() {
  return metricNames();
}

function renderCategorySelect() {
  const select = el("categorySelect");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">选择指标类</option>`;
  (state.categories || []).forEach((category) => {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = `${category.name}（${category.metrics.length}项）`;
    select.appendChild(option);
  });
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderCategoryLibrary() {
  const box = el("categoryLibrary");
  if (!box) return;
  const categories = state.categories || [];
  if (!categories.length) {
    box.innerHTML = `<div class="category-empty">暂无指标类，可勾选指标后保存为一类</div>`;
    return;
  }
  box.innerHTML = categories.map((category) => `
    <div class="category-card">
      <div>
        <strong>${escapeHtml(category.name)}</strong>
        <span>${escapeHtml(category.metrics.join("、"))}</span>
      </div>
      <button class="secondary small-btn" data-category-add="${category.id}">加入本次</button>
      <button class="icon-btn" data-category-remove="${category.id}">删除</button>
    </div>
  `).join("");
}

function saveCategoryFromSelected() {
  const name = el("categoryNameInput").value.trim();
  const metrics = selectedMetricNames();
  if (!name) {
    toast("请输入指标类名称");
    return;
  }
  if (!metrics.length) {
    toast("请先勾选要加入该类的指标");
    return;
  }
  const existing = (state.categories || []).find((category) => category.name === name);
  if (existing) {
    existing.metrics = metrics;
  } else {
    state.categories = [...(state.categories || []), normalizeCategory({ name, metrics })];
  }
  saveState();
  el("categoryNameInput").value = "";
  renderAll();
  toast(existing ? "已更新指标类" : "已保存指标类");
}

function addCategoryToDraft(categoryId = el("categorySelect").value) {
  const category = (state.categories || []).find((item) => item.id === categoryId);
  if (!category) {
    toast("请先选择指标类");
    return;
  }
  addMetricsToDraft(category.metrics);
}

function removeCategory(categoryId) {
  state.categories = (state.categories || []).filter((item) => item.id !== categoryId);
  saveState();
  renderAll();
  toast("已删除指标类");
}

function renderMetricSelect() {
  const select = el("metricSelect");
  const current = select.value;
  const options = metricOptions();
  select.innerHTML = "";
  if (!options.length) {
    select.innerHTML = `<option value="">暂无指标</option>`;
    return;
  }
  options.forEach((metric) => {
    const option = document.createElement("option");
    option.value = metric;
    option.textContent = metric;
    select.appendChild(option);
  });
  if (options.includes(current)) select.value = current;
}

function renderMetricLibrary() {
  const box = el("metricLibrary");
  if (!box) return;
  const metrics = metricLibraryOptions();
  box.innerHTML = "";
  if (!metrics.length) {
    box.innerHTML = `<span class="metric-chip">暂无指标</span>`;
    return;
  }
  metrics.forEach((metric) => {
    const config = metricConfig(metric);
    const chip = document.createElement("span");
    chip.className = "metric-chip";
    chip.innerHTML = `
      <input type="checkbox" data-metric-check="${escapeHtml(metric)}" aria-label="选择 ${escapeHtml(metric)}" />
      <input class="metric-edit-name" data-metric-edit="${escapeHtml(metric)}" data-field="name" value="${escapeHtml(metric)}" aria-label="指标名称" />
      <input class="metric-edit-unit" data-metric-edit="${escapeHtml(metric)}" data-field="unit" value="${escapeHtml(config.unit)}" placeholder="单位" aria-label="单位" />
      <input class="metric-edit-bound" data-metric-edit="${escapeHtml(metric)}" data-field="min" value="${escapeHtml(config.min)}" placeholder="最低值" aria-label="最低值" />
      <input class="metric-edit-bound" data-metric-edit="${escapeHtml(metric)}" data-field="max" value="${escapeHtml(config.max)}" placeholder="最高值" aria-label="最高值" />
      <button class="add-metric-btn" data-metric-add="${escapeHtml(metric)}">录入</button>
      <button class="save-metric-btn" data-metric-save="${escapeHtml(metric)}">保存</button>
      <button class="remove-metric-btn" data-metric-remove="${escapeHtml(metric)}">删除</button>
    `;
    box.appendChild(chip);
  });
}

function selectedMetricNames() {
  return [...document.querySelectorAll("[data-metric-check]:checked")]
    .map((item) => item.dataset.metricCheck);
}

function toggleAllMetrics() {
  const checks = [...document.querySelectorAll("[data-metric-check]")];
  if (!checks.length) {
    toast("暂无可选择的指标");
    return;
  }
  const shouldCheck = checks.some((item) => !item.checked);
  checks.forEach((item) => {
    item.checked = shouldCheck;
  });
  el("toggleAllMetricsBtn").textContent = shouldCheck ? "取消全选" : "全选";
}

function syncToggleAllLabel() {
  const checks = [...document.querySelectorAll("[data-metric-check]")];
  el("toggleAllMetricsBtn").textContent = checks.length && checks.every((item) => item.checked)
    ? "取消全选"
    : "全选";
}

function updateMetric(originalName) {
  const inputs = [...document.querySelectorAll("[data-metric-edit]")]
    .filter((input) => input.dataset.metricEdit === originalName);
  const next = {
    name: normalizeMetric(inputs.find((input) => input.dataset.field === "name")?.value || ""),
    unit: inputs.find((input) => input.dataset.field === "unit")?.value.trim() || "",
    min: inputs.find((input) => input.dataset.field === "min")?.value.trim() || "",
    max: inputs.find((input) => input.dataset.field === "max")?.value.trim() || "",
  };
  if (!next.name) {
    toast("指标名称不能为空");
    return;
  }
  state.metrics = uniqueMetricConfigs([
    ...(state.metrics || []).filter((item) => normalizeMetricConfig(item).name !== originalName),
    next,
  ]);
  state.categories = (state.categories || []).map((category) => ({
    ...category,
    metrics: category.metrics.map((metric) => metric === originalName ? next.name : metric),
  }));
  draftRows = draftRows.map((row) => {
    if (normalizeMetric(row.metric) !== originalName) return row;
    return applyMetricDefaults({ ...row, metric: next.name, unit: "", range: "" });
  });
  saveState();
  renderAll();
  renderDraft();
  toast("已保存指标");
}

function addMetric() {
  const input = el("metricNameInput");
  const metric = normalizeMetric(input.value);
  if (!metric) {
    toast("请输入指标名称");
    return;
  }
  const existed = metricLibraryOptions().includes(metric);
  state.metrics = uniqueMetricConfigs([...(state.metrics || []), {
    name: metric,
    unit: el("metricUnitInput").value.trim(),
    min: el("metricMinInput").value.trim(),
    max: el("metricMaxInput").value.trim(),
  }]);
  saveState();
  input.value = "";
  el("metricUnitInput").value = "";
  el("metricMinInput").value = "";
  el("metricMaxInput").value = "";
  renderAll();
  renderDraft();
  toast(existed ? "已更新指标" : "已添加指标");
}

function removeMetric(metric) {
  state.metrics = (state.metrics || []).filter((item) => normalizeMetricConfig(item).name !== metric);
  draftRows = draftRows.filter((row) => normalizeMetric(row.metric) !== metric);
  state.categories = (state.categories || []).map((category) => ({
    ...category,
    metrics: category.metrics.filter((item) => item !== metric),
  }));
  saveState();
  renderAll();
  renderDraft();
  toast("已从指标库删除");
}

function deleteSelectedMetrics() {
  const checked = selectedMetricNames();
  if (!checked.length) {
    toast("请先勾选要删除的指标");
    return;
  }
  state.metrics = (state.metrics || []).filter((item) => !checked.includes(normalizeMetricConfig(item).name));
  draftRows = draftRows.filter((row) => !checked.includes(normalizeMetric(row.metric)));
  state.categories = (state.categories || []).map((category) => ({
    ...category,
    metrics: category.metrics.filter((metric) => !checked.includes(metric)),
  }));
  saveState();
  renderAll();
  renderDraft();
  toast(`已删除 ${checked.length} 个指标`);
}

function getChartData(metric) {
  const range = el("rangeSelect").value;
  const minDate =
    range === "all"
      ? null
      : new Date(Date.now() - Number(range) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return state.records
    .filter((record) => !minDate || record.date >= minDate)
    .flatMap((record) =>
      record.rows
        .filter((row) => row.metric === metric)
        .map((row) => ({ ...row, date: record.date, type: record.type }))
    )
    .sort((a, b) => a.date.localeCompare(b.date));
}

function renderChart() {
  const metric = el("metricSelect").value;
  const box = el("chart");
  const data = getChartData(metric);
  if (!metric || !data.length) {
    box.className = "chart empty";
    box.textContent = "暂无数据，先保存一次报告记录";
    return;
  }

  box.className = "chart";
  const width = 860;
  const height = 330;
  const pad = { left: 58, right: 24, top: 32, bottom: 58 };
  const values = data.map((d) => d.value);
  const ranges = data.map((d) => parseRange(d.range)).filter(Boolean);
  const rangeValues = ranges.flatMap((r) => [r.min, r.max]);
  const min = Math.min(...values, ...rangeValues);
  const max = Math.max(...values, ...rangeValues);
  const spread = max - min || 1;
  const yMin = min - spread * 0.18;
  const yMax = max + spread * 0.18;
  const xStep = data.length > 1 ? (width - pad.left - pad.right) / (data.length - 1) : 0;
  const x = (i) => pad.left + i * xStep;
  const y = (v) => pad.top + (yMax - v) * (height - pad.top - pad.bottom) / (yMax - yMin);
  const points = data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => yMin + (yMax - yMin) * i / 4);
  const latestRange = [...data].reverse().map((d) => parseRange(d.range)).find(Boolean);
  const unit = data.find((d) => d.unit)?.unit || "";
  const firstDate = data[0].date;
  const lastDate = data[data.length - 1].date;
  const chemoEvents = state.events
    .map(normalizeEvent)
    .filter((event) => event.type === "化疗" || event.text.includes("化疗") || event.cycle.includes("化疗"))
    .sort((a, b) => eventDateTime(a).localeCompare(eventDateTime(b)));
  const chemoMarkers = chemoEvents.filter((event) => event.date >= firstDate && event.date <= lastDate);
  const cyclePalette = ["#dbeafe", "#dcfce7", "#fef3c7", "#ede9fe", "#fee2e2", "#cffafe"];

  const markerX = (date) => {
    if (data.length === 1) return pad.left;
    const dates = data.map((d) => new Date(d.date).getTime());
    const t = new Date(date).getTime();
    const ratio = (t - dates[0]) / (dates[dates.length - 1] - dates[0] || 1);
    return pad.left + Math.max(0, Math.min(1, ratio)) * (width - pad.left - pad.right);
  };
  const cycleForDate = (date) => {
    let cycleIndex = -1;
    chemoEvents.forEach((event, index) => {
      if (event.date <= date) cycleIndex = index;
    });
    return cycleIndex;
  };
  const cycleLabelForDate = (date) => {
    const cycleIndex = cycleForDate(date);
    return cycleIndex >= 0 ? `C${cycleIndex + 1}` : "";
  };
  const cycleFillForDate = (date) => {
    const cycleIndex = cycleForDate(date);
    return cycleIndex >= 0 ? cyclePalette[cycleIndex % cyclePalette.length] : "transparent";
  };
  const labelRows = [pad.top + 14, pad.top + 29];
  const labelEnds = [0, 0];
  const cycleBands = chemoEvents
    .map((event, index) => {
      const next = chemoEvents[index + 1];
      if (event.date > lastDate || (next && next.date < firstDate)) return "";
      const start = event.date < firstDate ? firstDate : event.date;
      const end = next && next.date <= lastDate ? next.date : lastDate;
      const xStart = markerX(start);
      const xEnd = markerX(end);
      const bandWidth = Math.max(10, xEnd - xStart);
      const fullLabel = event.cycle || `第 ${index + 1} 次化疗`;
      const shortLabel = `C${index + 1}`;
      const label = bandWidth > 78 ? fullLabel : shortLabel;
      const labelWidth = Math.min(86, label.length * 12);
      const rowIndex = labelEnds[0] <= xStart ? 0 : labelEnds[1] <= xStart ? 1 : 0;
      labelEnds[rowIndex] = xStart + labelWidth + 8;
      return `<rect x="${xStart}" y="${pad.top}" width="${Math.max(10, xEnd - xStart)}" height="${height - pad.top - pad.bottom}" fill="${cyclePalette[index % cyclePalette.length]}" opacity="0.36">
        <title>${escapeSvg(event.cycle || `第 ${index + 1} 次化疗`)}</title>
      </rect>
      <text x="${xStart + 5}" y="${labelRows[rowIndex]}" fill="#1745bd" font-size="11">
        <title>${escapeSvg(fullLabel)}</title>${escapeSvg(label)}
      </text>`;
    })
    .join("");

  box.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(metric)} 趋势图">
      <rect width="${width}" height="${height}" fill="#fbfdff"></rect>
      ${cycleBands}
      <text x="${pad.left}" y="22" fill="#162033" font-size="16" font-weight="700">${escapeSvg(metric)} ${escapeSvg(unit)}</text>
      ${ticks
        .map((tick) => {
          const yy = y(tick);
          return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}" stroke="#e6edf5" />
            <text x="${pad.left - 10}" y="${yy + 4}" text-anchor="end" fill="#667085" font-size="12">${formatNumber(tick)}</text>`;
        })
        .join("")}
      ${
        latestRange
          ? `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(latestRange.min)}" y2="${y(latestRange.min)}" stroke="#16a34a" stroke-dasharray="5 5" />
             <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(latestRange.max)}" y2="${y(latestRange.max)}" stroke="#dc2626" stroke-dasharray="5 5" />
             <rect x="${width - pad.right - 58}" y="${Math.max(pad.top + 2, y(latestRange.min) + 6)}" width="58" height="17" fill="#fbfdff" opacity="0.88" rx="4" />
             <rect x="${width - pad.right - 58}" y="${Math.max(pad.top + 2, y(latestRange.max) - 22)}" width="58" height="17" fill="#fbfdff" opacity="0.88" rx="4" />
             <text x="${width - pad.right - 4}" y="${Math.max(pad.top + 15, y(latestRange.min) + 19)}" text-anchor="end" fill="#16803c" font-size="12">参考下限</text>
             <text x="${width - pad.right - 4}" y="${Math.max(pad.top + 15, y(latestRange.max) - 9)}" text-anchor="end" fill="#b42318" font-size="12">参考上限</text>`
          : ""
      }
      ${chemoMarkers
        .map((event) => {
          const xx = markerX(event.date);
          return `<line x1="${xx}" x2="${xx}" y1="${pad.top}" y2="${height - pad.bottom}" stroke="#2563eb" stroke-dasharray="4 4" stroke-width="1.5">
            <title>${escapeSvg(event.cycle || "化疗开始")}</title>
          </line>`;
        })
        .join("")}
      <polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      ${data
        .map((d, i) => {
          const color = d.status.includes("高") ? "#b42318" : d.status.includes("低") ? "#b45309" : "#2563eb";
          return `<circle cx="${x(i)}" cy="${y(d.value)}" r="5" fill="${color}">
            <title>${escapeSvg(d.date)} ${escapeSvg(d.metric)} ${d.value}${escapeSvg(d.unit)} ${escapeSvg(d.status)}</title>
          </circle>
          <text x="${x(i)}" y="${height - 40}" text-anchor="middle" fill="#667085" font-size="12">${formatDate(d.date)}</text>
          <text x="${x(i)}" y="${height - 24}" text-anchor="middle" fill="#1745bd" font-size="11">${escapeSvg(cycleLabelForDate(d.date))}</text>
          <text x="${x(i)}" y="${y(d.value) - 10}" text-anchor="middle" fill="${color}" font-size="12">${formatNumber(d.value)}</text>`;
        })
        .join("")}
    </svg>
  `;
}

function escapeSvg(value) {
  return escapeHtml(value).replaceAll("'", "&apos;");
}

function formatNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function formatDate(date) {
  return date.slice(5).replace("-", "/");
}

function renderEvents() {
  const list = el("eventList");
  list.innerHTML = "";
  if (!state.events.length) {
    list.innerHTML = `<li><span>暂无事件</span></li>`;
    return;
  }
  [...state.events]
    .map(normalizeEvent)
    .sort((a, b) => eventDateTime(b).localeCompare(eventDateTime(a)))
    .forEach((event) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="event-edit-grid">
          <input data-event-edit="${event.id}" data-field="date" type="date" value="${escapeHtml(event.date)}" />
          <input data-event-edit="${event.id}" data-field="time" type="time" value="${escapeHtml(event.time)}" />
          <select data-event-edit="${event.id}" data-field="type">
            ${["发现病情", "初诊", "手术", "化疗", "用药", "升白针", "发热", "住院", "复诊", "其他", "事件"].map((type) => `<option ${type === event.type ? "selected" : ""}>${type}</option>`).join("")}
          </select>
          <input data-event-edit="${event.id}" data-field="cycle" value="${escapeHtml(event.cycle)}" placeholder="疗程/周期" />
          <input data-event-edit="${event.id}" data-field="text" value="${escapeHtml(event.text)}" placeholder="事件名称" />
          <textarea data-event-edit="${event.id}" data-field="drugs" rows="2" placeholder="用药情况">${escapeHtml(event.drugs)}</textarea>
          <textarea data-event-edit="${event.id}" data-field="note" rows="2" placeholder="备注">${escapeHtml(event.note)}</textarea>
        </div>
        <button class="save-metric-btn" data-event-save="${event.id}">保存</button>
        <button class="icon-btn" data-event-remove="${event.id}">删除</button>
      `;
      list.appendChild(li);
    });
}

function addEvent() {
  const date = el("eventDate").value || today();
  const time = el("eventTime").value;
  const type = el("eventType").value;
  const cycle = el("eventCycle").value.trim();
  const text = el("eventText").value.trim();
  const drugs = el("eventDrugs").value.trim();
  const note = el("eventNote").value.trim();
  if (!text && !cycle && !drugs && !note) {
    toast("请输入事件内容");
    return;
  }
  state.events.push(normalizeEvent({ id: crypto.randomUUID(), date, time, type, cycle, text, drugs, note }));
  saveState();
  el("eventTime").value = "";
  el("eventCycle").value = "";
  el("eventText").value = "";
  el("eventDrugs").value = "";
  el("eventNote").value = "";
  renderAll();
  toast("已添加治疗事件");
}

function saveEvent(eventId) {
  const inputs = [...document.querySelectorAll(`[data-event-edit="${eventId}"]`)];
  const next = {};
  inputs.forEach((input) => {
    next[input.dataset.field] = input.value;
  });
  state.events = state.events.map((event) => event.id === eventId ? normalizeEvent({ ...event, ...next }) : event);
  saveState();
  renderAll();
  toast("已保存治疗事件");
}

function renderRecords() {
  const box = el("records");
  box.innerHTML = "";
  if (!state.records.length) {
    box.innerHTML = `<div class="record-card"><span>暂无历史记录</span></div>`;
    return;
  }
  [...state.records]
    .sort((a, b) => b.date.localeCompare(a.date))
    .forEach((record) => {
      const div = document.createElement("div");
      div.className = "record-card";
      const abnormal = record.rows.filter((row) => row.status.includes("高") || row.status.includes("低"));
      div.innerHTML = `
        <div>
          <div class="record-edit-head">
            <input data-record-edit="${record.id}" data-field="date" type="date" value="${escapeHtml(record.date)}" />
            <select data-record-edit="${record.id}" data-field="type">
              ${["血常规", "肿瘤标志物", "肝肾功能", "电解质", "其他"].map((type) => `<option ${type === record.type ? "selected" : ""}>${type}</option>`).join("")}
            </select>
            <button class="save-metric-btn" data-record-save="${record.id}">保存</button>
          </div>
          <span>${record.rows.length} 个指标，异常 ${abnormal.length} 项</span>
          ${renderMetricDetailTable(record.rows, record.id)}
        </div>
        <button class="icon-btn" data-record-remove="${record.id}">删除</button>
      `;
      box.appendChild(div);
    });
}

function renderMetricDetailTable(rows, recordId = "") {
  if (!rows?.length) return "";
  return `
    <details class="detail-block">
      <summary>查看全部指标</summary>
      <div class="mini-table-wrap">
        <table class="mini-table">
          <thead>
            <tr><th>指标</th><th>结果</th><th>单位</th><th>参考范围</th><th>状态</th></tr>
          </thead>
          <tbody>
            ${rows.map((row, index) => `
              <tr>
                <td>${recordId ? `<input data-record-row="${recordId}" data-index="${index}" data-field="metric" value="${escapeHtml(row.metric)}" />` : escapeHtml(row.metric)}</td>
                <td>${recordId ? `<input data-record-row="${recordId}" data-index="${index}" data-field="value" value="${escapeHtml(row.value)}" />` : escapeHtml(row.value)}</td>
                <td>${recordId ? `<input data-record-row="${recordId}" data-index="${index}" data-field="unit" value="${escapeHtml(row.unit || "")}" />` : escapeHtml(row.unit || "-")}</td>
                <td>${recordId ? `<input data-record-row="${recordId}" data-index="${index}" data-field="range" value="${escapeHtml(row.range || "")}" />` : escapeHtml(row.range || "-")}</td>
                <td><span class="${statusClass(row.status)}">${escapeHtml(row.status || "未标注")}</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </details>
  `;
}

function saveRecord(recordId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  [...document.querySelectorAll(`[data-record-edit="${recordId}"]`)].forEach((input) => {
    record[input.dataset.field] = input.value;
  });
  [...document.querySelectorAll(`[data-record-row="${recordId}"]`)].forEach((input) => {
    const index = Number(input.dataset.index);
    const field = input.dataset.field;
    if (!record.rows[index]) return;
    record.rows[index][field] = input.value;
  });
  record.rows = record.rows
    .map((row) => {
      const value = Number(row.value);
      return {
        ...row,
        metric: normalizeMetric(row.metric),
        value,
        status: statusForValue(value, parseRange(row.range)?.min ?? "", parseRange(row.range)?.max ?? ""),
      };
    })
    .filter((row) => row.metric && !Number.isNaN(row.value));
  state.records.sort((a, b) => a.date.localeCompare(b.date));
  saveState();
  renderAll();
  toast("已保存历史记录");
}

function eventDateTime(event) {
  return `${event.date || ""}T${event.time || "00:00"}`;
}

function renderTimeline() {
  const box = el("timeline");
  if (!box) return;
  const items = [
    ...state.events.map((event) => ({ kind: "event", data: normalizeEvent(event) })),
    ...state.records.map((record) => ({ kind: "record", data: record })),
  ].sort((a, b) => {
    const byTime = cycleItemTime(a).localeCompare(cycleItemTime(b));
    if (byTime !== 0) return byTime;
    return cycleItemPriority(a) - cycleItemPriority(b);
  });

  if (!items.length) {
    box.innerHTML = `<div class="timeline-empty">暂无完整情况记录</div>`;
    return;
  }

  box.innerHTML = renderPointTimeline(items, "global");
}

function cycleItemPriority(item) {
  if (item.kind === "record") return 0;
  const type = item.data.type;
  if (type === "复诊") return 1;
  if (type === "用药") return 2;
  if (type === "发现病情") return 3;
  if (type === "初诊") return 4;
  if (type === "手术") return 5;
  if (type === "化疗") return 6;
  if (type === "升白针") return 7;
  if (type === "发热") return 8;
  if (type === "住院") return 9;
  return 8;
}

function cycleItemTime(item) {
  if (item.kind === "record") return `${item.data.date}T00:00`;
  return eventDateTime(item.data);
}

function cyclePointClass(item) {
  if (item.kind === "group") {
    if (item.items.some((entry) => entry.kind === "event" && entry.data.type === "化疗")) return "point-chemo";
    if (item.items.some((entry) => entry.kind === "record")) return "point-record";
    if (item.items.some((entry) => entry.kind === "event" && entry.data.type === "用药")) return "point-med";
    return "point-other";
  }
  if (item.kind === "record") return "point-record";
  const type = item.data.type;
  if (type === "化疗") return "point-chemo";
  if (type === "用药") return "point-med";
  if (type === "复诊") return "point-followup";
  if (type === "发现病情") return "point-discovery";
  if (type === "初诊") return "point-firstvisit";
  if (type === "手术") return "point-surgery";
  if (type === "升白针") return "point-injection";
  if (type === "发热") return "point-fever";
  if (type === "住院") return "point-hospital";
  return "point-other";
}

function cyclePointLabel(item, index) {
  if (item.kind === "group") return item.items.map((entry, itemIndex) => cyclePointLabel(entry, itemIndex)).join("、");
  if (item.kind === "record") return item.data.type || "指标";
  return item.data.text || item.data.type || `事件${index + 1}`;
}

function cyclePointTitle(item) {
  if (item.kind === "group") {
    return `${item.date}：${item.items.map((entry) => cyclePointTitle(entry)).join("；")}`;
  }
  if (item.kind === "record") {
    const abnormal = item.data.rows.filter((row) => row.status.includes("高") || row.status.includes("低"));
    const abnormalText = abnormal.length
      ? `异常：${abnormal.map((row) => `${row.metric}${row.status}`).join("、")}`
      : "无异常标记";
    return `${item.data.date} ${item.data.type}，${item.data.rows.length}个指标，${abnormalText}`;
  }
  const event = item.data;
  return [
    `${event.date}${event.time ? ` ${event.time}` : ""} ${event.type}`,
    event.cycle,
    event.text,
    event.drugs ? `用药：${event.drugs}` : "",
    event.note ? `备注：${event.note}` : "",
  ].filter(Boolean).join("；");
}

function renderCycleItemDetail(item) {
  if (item.kind === "group") {
    return `
      <strong>${item.date} · 当日详情</strong>
      <div class="day-detail-list">
        ${item.items.map((entry) => `<div class="day-detail-item">${renderCycleItemDetail(entry)}</div>`).join("")}
      </div>
    `;
  }
  if (item.kind === "record") {
    const abnormal = item.data.rows.filter((row) => row.status.includes("高") || row.status.includes("低"));
    return `
      <strong>${item.data.date} · ${escapeHtml(item.data.type)} · 检测指标</strong>
      <p>${item.data.rows.length} 个指标，异常 ${abnormal.length} 项</p>
      ${renderMetricDetailTable(item.data.rows)}
    `;
  }
  const event = item.data;
  return `
    <strong>${event.date}${event.time ? ` ${event.time}` : ""} · ${escapeHtml(event.type)}</strong>
    <p>${escapeHtml([event.cycle, event.text].filter(Boolean).join(" · ") || "未命名事件")}</p>
    ${event.drugs ? `<p><b>用药：</b>${escapeHtml(event.drugs)}</p>` : ""}
    ${event.note ? `<p><b>备注：</b>${escapeHtml(event.note)}</p>` : ""}
  `;
}

function groupItemsByDate(items) {
  const groups = new Map();
  items.forEach((item) => {
    const date = item.kind === "record" ? item.data.date : item.data.date;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  });
  return [...groups.entries()]
    .map(([date, groupItems]) => ({
      kind: "group",
      date,
      items: groupItems.sort((a, b) => {
        const byTime = cycleItemTime(a).localeCompare(cycleItemTime(b));
        if (byTime !== 0) return byTime;
        return cycleItemPriority(a) - cycleItemPriority(b);
      }),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function renderCycleTextList(items) {
  if (!items.length) return `<p>这个周期下暂无事件或指标记录</p>`;
  return `
    <div class="cycle-text-list">
      ${items.map((item) => {
        if (item.kind === "record") {
          const record = item.data;
          const abnormal = record.rows.filter((row) => row.status.includes("高") || row.status.includes("低"));
          return `
            <div class="cycle-text-item">
              <b>${record.date} · ${escapeHtml(record.type)} · 指标记录</b>
              <span>${record.rows.length} 个指标，异常 ${abnormal.length} 项</span>
              ${renderMetricDetailTable(record.rows)}
            </div>
          `;
        }
        const event = item.data;
        return `
          <div class="cycle-text-item">
            <b>${event.date}${event.time ? ` ${event.time}` : ""} · ${escapeHtml(event.type)}</b>
            <span>${escapeHtml([event.cycle, event.text].filter(Boolean).join(" · ") || "未命名事件")}</span>
            ${event.drugs ? `<span>用药：${escapeHtml(event.drugs)}</span>` : ""}
            ${event.note ? `<span>备注：${escapeHtml(event.note)}</span>` : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderPointTimeline(items, scope) {
  if (!items.length) return `<p>这个周期下暂无事件或指标记录</p>`;
  const displayItems = scope === "global" ? groupItemsByDate(items) : items;
  return `
    <div class="cycle-axis" style="--point-count:${displayItems.length}">
      ${displayItems.map((item, index) => {
        const id = `${scope}-item-${index}`;
        return `
          <button class="cycle-point ${cyclePointClass(item)} ${index === 0 ? "active" : ""}" data-cycle-point="${id}" title="${escapeHtml(cyclePointTitle(item))}">
            <span class="dot"></span>
            <span class="point-date">${escapeHtml((item.kind === "group" ? item.date : cycleItemTime(item).slice(0, 10)).slice(5).replace("-", "/"))}</span>
            <span class="point-label">${renderPointLabels(item, index)}</span>
          </button>
        `;
      }).join("")}
    </div>
    <div class="cycle-detail-list">
      ${displayItems.map((item, index) => {
        const id = `${scope}-item-${index}`;
        return `
          <div class="cycle-detail ${index === 0 ? "active" : ""}" data-cycle-detail="${id}">
            ${renderCycleItemDetail(item)}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderPointLabels(item, index) {
  const labels = item.kind === "group"
    ? item.items.map((entry, itemIndex) => cyclePointLabel(entry, itemIndex))
    : [cyclePointLabel(item, index)];
  return labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("");
}

function renderCycleSummary() {
  const box = el("cycleSummary");
  if (!box) return;
  const events = state.events.map(normalizeEvent);
  const chemoEvents = state.events
    .map(normalizeEvent)
    .filter((event) => event.type === "化疗" || event.text.includes("化疗") || event.cycle.includes("化疗"))
    .sort((a, b) => eventDateTime(a).localeCompare(eventDateTime(b)));

  if (!chemoEvents.length) {
    box.innerHTML = `<div class="timeline-empty">暂无化疗开始记录；添加“化疗”事件后会自动汇总当期指标。</div>`;
    return;
  }

  box.innerHTML = `
    <h3>化疗周期汇总</h3>
    ${chemoEvents.map((event, index) => {
      const next = chemoEvents[index + 1];
      const cycleEvents = events
        .filter((item) => eventDateTime(item) >= eventDateTime(event) && (!next || eventDateTime(item) < eventDateTime(next)))
      const records = state.records
        .filter((record) => record.date >= event.date && (!next || record.date < next.date));
      const cycleItems = [
        ...cycleEvents.map((item) => ({ kind: "event", data: item })),
        ...records.map((record) => ({ kind: "record", data: record })),
      ].sort((a, b) => {
        const byTime = cycleItemTime(a).localeCompare(cycleItemTime(b));
        if (byTime !== 0) return byTime;
        return cycleItemPriority(a) - cycleItemPriority(b);
      });
      return `
        <details class="cycle-card" ${index === chemoEvents.length - 1 ? "open" : ""}>
          <summary>
            ${escapeHtml(event.cycle || `第 ${index + 1} 次化疗`)} · ${event.date}${event.time ? ` ${event.time}` : ""}
            <span>${records.length} 次指标记录</span>
          </summary>
          <div class="cycle-body">
            ${renderCycleTextList(cycleItems)}
          </div>
        </details>
      `;
    }).join("")}
  `;
}

function exportCsv() {
  const header = ["检测日期", "报告类型", "指标", "结果", "单位", "参考范围", "状态"];
  const lines = [header, ...state.records.flatMap((record) =>
    record.rows.map((row) => [
      record.date,
      record.type,
      row.metric,
      row.value,
      row.unit,
      row.range,
      row.status,
    ])
  )];
  const csv = lines.map((line) => line.map(csvCell).join(",")).join("\n");
  downloadTextFile(`化疗指标记录-${today()}.csv`, "\ufeff" + csv, "text/csv;charset=utf-8");
}

function exportBackup() {
  const backup = {
    app: "chemo-lab-tracker",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: normalizeState(state),
  };
  downloadTextFile(
    `化疗指标完整备份-${today()}.json`,
    JSON.stringify(backup, null, 2),
    "application/json;charset=utf-8"
  );
  toast("已导出完整备份");
}

function importBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || ""));
      const data = parsed.data || parsed;
      if (!Array.isArray(data.records) && !Array.isArray(data.events) && !Array.isArray(data.metrics)) {
        throw new Error("invalid backup");
      }
      if (!confirm("导入备份会覆盖当前浏览器中的本地数据，确认继续吗？")) return;
      state = normalizeState(data);
      saveState();
      draftRows = [];
      renderDraft();
      renderAll();
      toast("已导入完整备份");
    } catch {
      toast("备份文件格式不正确");
    } finally {
      el("backupImportInput").value = "";
    }
  };
  reader.readAsText(file, "utf-8");
}

function downloadTextFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function loadSample() {
  state = {
    records: [
      {
        id: crypto.randomUUID(),
        date: "2026-06-01",
        type: "血常规",
        rows: [
          { metric: "白细胞 WBC", value: 4.6, unit: "10^9/L", range: "3.5-9.5", status: "正常" },
          { metric: "血红蛋白 HGB", value: 119, unit: "g/L", range: "115-150", status: "正常" },
          { metric: "血小板 PLT", value: 185, unit: "10^9/L", range: "125-350", status: "正常" },
        ],
      },
      {
        id: crypto.randomUUID(),
        date: "2026-06-08",
        type: "血常规",
        rows: [
          { metric: "白细胞 WBC", value: 3.1, unit: "10^9/L", range: "3.5-9.5", status: "偏低" },
          { metric: "血红蛋白 HGB", value: 108, unit: "g/L", range: "115-150", status: "偏低" },
          { metric: "血小板 PLT", value: 156, unit: "10^9/L", range: "125-350", status: "正常" },
        ],
      },
      {
        id: crypto.randomUUID(),
        date: "2026-06-15",
        type: "肿瘤标志物",
        rows: [
          { metric: "CEA", value: 8.2, unit: "ng/mL", range: "0-5", status: "偏高" },
          { metric: "CA19-9", value: 39, unit: "U/mL", range: "0-37", status: "偏高" },
        ],
      },
      {
        id: crypto.randomUUID(),
        date: "2026-06-22",
        type: "肝肾功能",
        rows: [
          { metric: "ALT", value: 42, unit: "U/L", range: "7-40", status: "偏高" },
          { metric: "AST", value: 31, unit: "U/L", range: "13-35", status: "正常" },
          { metric: "肌酐 CREA", value: 66, unit: "umol/L", range: "45-84", status: "正常" },
        ],
      },
    ],
    events: [
      {
        id: crypto.randomUUID(),
        date: "2026-06-03",
        time: "09:30",
        type: "化疗",
        cycle: "第 1 次化疗",
        text: "开始输注",
        drugs: "奥沙利铂 + 卡培他滨",
        note: "记录实际用药请以医嘱为准",
      },
      { id: crypto.randomUUID(), date: "2026-06-10", time: "", type: "升白针", cycle: "", text: "升白针", drugs: "", note: "" },
    ],
  };
  state = normalizeState(state);
  saveState();
  renderAll();
  toast("已载入示例数据");
}

function renderAll() {
  renderCategorySelect();
  renderCategoryLibrary();
  renderMetricSelect();
  renderMetricLibrary();
  renderChart();
  renderEvents();
  renderRecords();
  renderCycleSummary();
  renderTimeline();
}

function panelKey(panel, index) {
  return [...panel.classList].find((name) => name.endsWith("-panel")) || `panel-${index}`;
}

function updatePanelButton(panel) {
  const button = panel.querySelector(".collapse-btn");
  if (!button) return;
  const collapsed = panel.classList.contains("collapsed");
  button.textContent = collapsed ? "展开" : "折叠";
  button.setAttribute("aria-expanded", String(!collapsed));
}

function setPanelCollapsed(panel, collapsed) {
  panel.classList.toggle("collapsed", collapsed);
  updatePanelButton(panel);
  const states = loadPanelState();
  states[panel.dataset.panelKey] = collapsed;
  savePanelState(states);
}

function setupPanelCollapse() {
  const states = loadPanelState();
  document.querySelectorAll(".panel").forEach((panel, index) => {
    const head = panel.querySelector(".section-head");
    if (!head) return;
    panel.dataset.panelKey = panel.dataset.panelKey || panelKey(panel, index);
    if (!head.querySelector(".collapse-btn")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "collapse-btn";
      button.addEventListener("click", () => setPanelCollapsed(panel, !panel.classList.contains("collapsed")));
      head.appendChild(button);
    }
    panel.classList.toggle("collapsed", Boolean(states[panel.dataset.panelKey]));
    updatePanelButton(panel);
  });
}

function setAllPanels(collapsed) {
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("collapsed", collapsed);
    updatePanelButton(panel);
  });
  const states = {};
  document.querySelectorAll(".panel").forEach((panel) => {
    states[panel.dataset.panelKey] = collapsed;
  });
  savePanelState(states);
}

function bindEvents() {
  setupPanelCollapse();
  el("testDate").value = today();
  el("eventDate").value = today();
  el("familyCode").value = localStorage.getItem(FAMILY_CODE_KEY) || "default-family";
  el("signInBtn").addEventListener("click", signInCloud);
  el("signUpBtn").addEventListener("click", signUpCloud);
  el("signOutBtn").addEventListener("click", signOutCloud);
  el("familyCode").addEventListener("change", async () => {
    localStorage.setItem(FAMILY_CODE_KEY, getFamilyCode());
    if (cloudUser) await loadCloudState();
  });
  el("addCategoryToDraftBtn").addEventListener("click", () => addCategoryToDraft());
  el("addRowBtn").addEventListener("click", () => addDraftRow());
  el("saveBtn").addEventListener("click", saveDraft);
  el("eventBtn").addEventListener("click", addEvent);
  el("metricAddBtn").addEventListener("click", addMetric);
  el("toggleAllMetricsBtn").addEventListener("click", toggleAllMetrics);
  el("addSelectedMetricsBtn").addEventListener("click", addSelectedMetricsToDraft);
  el("addAllMetricsBtn").addEventListener("click", addAllMetricsToDraft);
  el("deleteSelectedMetricsBtn").addEventListener("click", deleteSelectedMetrics);
  el("saveCategoryBtn").addEventListener("click", saveCategoryFromSelected);
  el("metricNameInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addMetric();
  });
  el("metricSelect").addEventListener("change", renderChart);
  el("rangeSelect").addEventListener("change", renderChart);
  el("exportBtn").addEventListener("click", exportCsv);
  el("backupExportBtn").addEventListener("click", exportBackup);
  el("backupImportBtn").addEventListener("click", () => el("backupImportInput").click());
  el("backupImportInput").addEventListener("change", (event) => importBackup(event.target.files[0]));
  el("expandAllBtn").addEventListener("click", () => setAllPanels(false));
  el("collapseAllBtn").addEventListener("click", () => setAllPanels(true));
  el("sampleBtn").addEventListener("click", loadSample);
  el("clearBtn").addEventListener("click", () => {
    if (!confirm("确认清空当前浏览器里的所有记录吗？")) return;
    state = normalizeState({ records: [], events: [], metrics: defaultMetrics });
    saveState();
    renderAll();
    toast("已清空本机数据");
  });

  el("draftBody").addEventListener("input", (event) => {
    const input = event.target;
    const index = Number(input.dataset.index);
    const field = input.dataset.field;
    if (!field || Number.isNaN(index)) return;
    draftRows[index][field] = input.value;
    if (field === "value") {
      draftRows[index] = applyMetricDefaults(draftRows[index]);
    }
  });

  el("draftBody").addEventListener("change", (event) => {
    const input = event.target;
    const index = Number(input.dataset.index);
    const field = input.dataset.field;
    if (!field || Number.isNaN(index)) return;
    draftRows[index][field] = input.value;
    if (field === "metric") {
      draftRows[index].unit = "";
      draftRows[index].range = "";
    }
    if (field === "metric" || field === "value") {
      draftRows[index] = applyMetricDefaults(draftRows[index]);
      renderDraft();
    }
  });

  document.addEventListener("click", (event) => {
    const removeIndex = event.target.dataset.remove;
    if (removeIndex !== undefined) {
      draftRows.splice(Number(removeIndex), 1);
      renderDraft();
    }
    const recordId = event.target.dataset.recordRemove;
    if (recordId) {
      state.records = state.records.filter((record) => record.id !== recordId);
      saveState();
      renderAll();
    }
    const eventId = event.target.dataset.eventRemove;
    if (eventId) {
      state.events = state.events.filter((item) => item.id !== eventId);
      saveState();
      renderAll();
    }
    const eventSave = event.target.dataset.eventSave;
    if (eventSave) {
      saveEvent(eventSave);
    }
    const metricRemove = event.target.dataset.metricRemove;
    if (metricRemove) {
      removeMetric(metricRemove);
    }
    const metricAdd = event.target.dataset.metricAdd;
    if (metricAdd) {
      addMetricToDraft(metricAdd);
    }
    const metricSave = event.target.dataset.metricSave;
    if (metricSave) {
      updateMetric(metricSave);
    }
    const recordSave = event.target.dataset.recordSave;
    if (recordSave) {
      saveRecord(recordSave);
    }
    const categoryAdd = event.target.dataset.categoryAdd;
    if (categoryAdd) {
      addCategoryToDraft(categoryAdd);
    }
    const categoryRemove = event.target.dataset.categoryRemove;
    if (categoryRemove) {
      removeCategory(categoryRemove);
    }
    const cyclePoint = event.target.closest("[data-cycle-point]");
    if (cyclePoint) {
      const detailId = cyclePoint.dataset.cyclePoint;
      const container = cyclePoint.closest(".cycle-card") || cyclePoint.closest(".timeline");
      if (!container) return;
      container.querySelectorAll("[data-cycle-point]").forEach((item) => item.classList.toggle("active", item === cyclePoint));
      container.querySelectorAll("[data-cycle-detail]").forEach((item) => item.classList.toggle("active", item.dataset.cycleDetail === detailId));
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.dataset.metricCheck !== undefined) {
      syncToggleAllLabel();
    }
  });
}

bindEvents();
initFirebase();
renderDraft();
renderAll();
