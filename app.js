import * as pdfjsLib from "https://unpkg.com/pdfjs-dist@5.4.449/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://unpkg.com/pdfjs-dist@5.4.449/build/pdf.worker.mjs";

// DOM
const fileInput = document.getElementById("file-input");
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const resultsSelect = document.getElementById("results-select");
const zoomSlider = document.getElementById("zoom-slider");
const zoomValue = document.getElementById("zoom-value");
const pdfContainer = document.getElementById("pdf-container");

// PDF state
let pdfDoc = null;

// Zoom / rendering
const OUTPUT_SCALE = window.devicePixelRatio || 1;
let currentScale = 1.0;

// Search cycle state (press Enter again to go to next match)
let lastQuerySig = null;
let lastMatches = [];
let lastMatchIndex = 0;

// Index entries: one per page that has a Name:
const entries = []; // { pageNum, nameRaw, numberKey, tokensKey }

// ---------- Helpers ----------

function setZoomFromSlider() {
  const percent = parseInt(zoomSlider.value, 10) || 100;
  currentScale = percent / 100;
  zoomValue.textContent = `${percent}%`;
}

// Normalize text: uppercase, only letters/numbers/spaces
function normalizeWords(s) {
  return (s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract numeric key "A-B" ignoring leading zeros
function extractNumberKey(text) {
  const nums = String(text || "").match(/\d+/g);
  if (!nums) return null;
  const ints = nums.map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
  if (ints.length >= 2) return `${ints[0]}-${ints[1]}`;
  if (ints.length === 1) return String(ints[0]);
  return null;
}

// Build a "tokensKey" for fuzzy word matching (no spaces)
function tokensKeyFromName(nameRaw) {
  // Example: "HILL CREEK UNIT 10-28F" -> "HILLCREEKUNIT"
  // Example: "LITTLE CANYON UNIT 05-12H" -> "LITTLECANYONUNIT"
  const cleaned = normalizeWords(nameRaw);

  // Remove pure number chunks & number-ish chunks like 10-28F
  const withoutNums = cleaned
    .split(" ")
    .filter((w) => !/\d/.test(w))
    .join(" ");

  // Collapse to a single key (letters only)
  return withoutNums.replace(/[^A-Z]/g, "");
}

// Basic similarity scoring:
// lower score = better match
function scoreEntry(query, entry) {
  const qNorm = normalizeWords(query);
  const qTokensKey = qNorm.replace(/[^A-Z]/g, ""); // letters only
  const qNum = extractNumberKey(qNorm);

  let score = 0;

  // --- numbers ---
  if (qNum) {
    if (entry.numberKey === qNum) {
      score -= 1000; // strong boost for exact number match
    } else if (entry.numberKey) {
      // numeric closeness fallback
      const qp = qNum.match(/(\d+)-(\d+)/);
      const ep = entry.numberKey.match(/(\d+)-(\d+)/);
      if (qp && ep) {
        const qa = parseInt(qp[1], 10);
        const qb = parseInt(qp[2], 10);
        const ea = parseInt(ep[1], 10);
        const eb = parseInt(ep[2], 10);
        score += Math.abs(qa - ea) + Math.abs(qb - eb);
      } else {
        score += 50;
      }
    } else {
      score += 200;
    }
  }

  // --- words (unit names) ---
  // If user typed words, reward substring matches
  const hasLetters = /[A-Z]/.test(qNorm);
  if (hasLetters) {
    if (qTokensKey.length > 0) {
      if (entry.tokensKey.includes(qTokensKey)) {
        score -= 300; // direct containment = very good
      } else if (qTokensKey.includes(entry.tokensKey)) {
        score -= 150;
      } else {
        // partial overlap heuristic
        // count common prefix length
        let common = 0;
        const a = entry.tokensKey;
        const b = qTokensKey;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
          if (a[i] === b[i]) common++;
          else break;
        }
        score += (20 - Math.min(common, 20)); // better prefix => smaller score
        score += 50;
      }
    }
  }

  return score;
}

function sortDropdown() {
  const options = Array.from(resultsSelect.options);
  const first = options.shift(); // keep placeholder
  options.sort((a, b) =>
    a.textContent.localeCompare(b.textContent, undefined, { numeric: true })
  );
  resultsSelect.innerHTML = "";
  resultsSelect.appendChild(first);
  options.forEach((o) => resultsSelect.appendChild(o));
}

function scrollToPage(pageNum) {
  const el = document.getElementById(`page-${pageNum}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });

  el.classList.add("highlight");
  setTimeout(() => el.classList.remove("highlight"), 900);
}

function jumpToPageAndSelect(pageNum) {
  scrollToPage(pageNum);
  for (const opt of resultsSelect.options) {
    if (Number(opt.value) === pageNum) {
      resultsSelect.value = opt.value;
      break;
    }
  }
}

// ---------- PDF loading ----------

async function loadPdfFromFile(file) {
  if (!file) return;

  
  // reset
  pdfDoc = null;
  entries.length = 0;
  lastQuerySig = null;
  lastMatches = [];
  lastMatchIndex = 0;

  resultsSelect.innerHTML =
    '<option value="">Names found (optional quick jump)...</option>';
  pdfContainer.innerHTML = "";

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  pdfDoc = await loadingTask.promise;

  // reset zoom
  zoomSlider.value = 100;
  setZoomFromSlider();

  await renderAllPages();
  await buildIndexFromNames();
  sortDropdown();
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await loadPdfFromFile(file);
  } catch (err) {
    console.error(err);
  }
});

// ---------- Rendering (all pages stacked) ----------

async function renderAllPages() {
  if (!pdfDoc) return;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentScale });

    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page";
    wrapper.id = `page-${pageNum}`;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = viewport.width * OUTPUT_SCALE;
    canvas.height = viewport.height * OUTPUT_SCALE;

    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    wrapper.appendChild(canvas);
    pdfContainer.appendChild(wrapper);

    await page.render({
      canvasContext: ctx,
      viewport,
      transform:
        OUTPUT_SCALE !== 1 ? [OUTPUT_SCALE, 0, 0, OUTPUT_SCALE, 0, 0] : undefined,
    }).promise;
  }
}

async function rerenderPages() {
  if (!pdfDoc) return;
  pdfContainer.innerHTML = "";
  await renderAllPages();
}

// ---------- Indexing ----------

async function buildIndexFromNames() {
  if (!pdfDoc) return;

  const monthRegex =
    /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{4}\b/i;

  const seen = new Set();

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");

    const NAME = "Name:";
    let pos = 0;

    while (true) {
      const idx = text.indexOf(NAME, pos);
      if (idx === -1) break;

      let after = text.slice(idx + NAME.length);

      const gasIdx = after.indexOf("GAS VOLUME STATEMENT");
      if (gasIdx !== -1) after = after.slice(0, gasIdx);

      const m = monthRegex.exec(after);
      if (m) after = after.slice(0, m.index);

      const nameRaw = after.trim();
      if (!nameRaw) {
        pos = idx + NAME.length;
        continue;
      }

      const unique = `${pageNum}::${nameRaw}`;
      if (!seen.has(unique)) {
        seen.add(unique);

        const entry = {
          pageNum,
          nameRaw,
          numberKey: extractNumberKey(nameRaw),
          tokensKey: tokensKeyFromName(nameRaw),
        };
        entries.push(entry);

        const opt = document.createElement("option");
        opt.value = String(pageNum);
        opt.textContent = `${nameRaw} (page ${pageNum})`;
        resultsSelect.appendChild(opt);
      }

      pos = idx + NAME.length;
    }
  }
}

// ---------- Search (fuzzy words + numbers) ----------

function doSearch() {
  if (!pdfDoc || entries.length === 0) return;

  const q = searchInput.value.trim();
  if (!q) return;

  // Build a query signature so Enter cycles results
  const qSig = normalizeWords(q);
  if (qSig !== lastQuerySig) {
    // New query: compute matches
    const scored = entries
      .map((e) => ({ e, s: scoreEntry(qSig, e) }))
      .sort((a, b) => a.s - b.s);

    // Keep a reasonable number of matches (best 20)
    lastMatches = scored.slice(0, 20).map((x) => x.e);
    lastMatchIndex = 0;
    lastQuerySig = qSig;
  } else {
    // Same query: cycle
    if (lastMatches.length > 0) {
      lastMatchIndex = (lastMatchIndex + 1) % lastMatches.length;
    }
  }

  if (!lastMatches.length) return;

  const target = lastMatches[lastMatchIndex];
  jumpToPageAndSelect(target.pageNum);
}

// Search triggers
searchBtn.addEventListener("click", doSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

// Dropdown: mouse selection jumps; arrow keys do NOT
let suppressSelectJump = false;
resultsSelect.addEventListener("keydown", (e) => {
  if (
    e.key === "ArrowUp" ||
    e.key === "ArrowDown" ||
    e.key === "PageUp" ||
    e.key === "PageDown"
  ) {
    suppressSelectJump = true;
  }
});
resultsSelect.addEventListener("change", (e) => {
  if (suppressSelectJump) {
    suppressSelectJump = false;
    return;
  }
  const pageNum = parseInt(e.target.value, 10);
  if (pageNum) jumpToPageAndSelect(pageNum);
});

// Zoom
setZoomFromSlider();
zoomSlider.addEventListener("change", async () => {
  setZoomFromSlider();
  await rerenderPages();
});
