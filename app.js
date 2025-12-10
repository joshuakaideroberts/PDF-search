

// ====== Import PDF.js as an ES module from the CDN ======
import * as pdfjsLib from "https://unpkg.com/pdfjs-dist@5.4.449/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://unpkg.com/pdfjs-dist@5.4.449/build/pdf.worker.mjs";

// DOM elements
const fileInput = document.getElementById("file-input");
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const resultsSelect = document.getElementById("results-select");
const statusEl = document.getElementById("status");
const pdfContainer = document.getElementById("pdf-container");

// How big each page should be (1.0 = 100%)
const DEFAULT_SCALE = 1.0; // a little zoomed out
const OUTPUT_SCALE = window.devicePixelRatio || 1; // for sharpness on HiDPI screens

// PDF state
let pdfDoc = null;

// Search cycle state (for multiple wells with same numbers, e.g. 1-29)
let lastSearchKey = null;
let lastSearchIndex = 0;

// Map of numeric key -> array of page numbers
// Example: "10-28" -> [8, 57]
const numberIndex = new Map();

// ---------- Helpers ----------

function setStatus(msg) {
  // do nothing
}


// Extract a numeric key from text.
//
// Examples:
//   "HILL CREEK UNIT 10-28 F"  -> "10-28"
//   "FEDERAL 01-29"            -> "1-29"
//   "03-30" or "3-30 F"        -> "3-30"
//   "13-03" or "13-3F"         -> "13-3"
function getNumberKeyFromText(text) {
  if (!text) return null;
  const nums = String(text).match(/\d+/g);
  if (!nums || nums.length === 0) return null;

  const ints = nums
    .map((n) => parseInt(n, 10))
    .filter((n) => !Number.isNaN(n));

  if (ints.length === 0) return null;

  if (ints.length >= 2) {
    return `${ints[0]}-${ints[1]}`;
  }
  // Fallback if only one number exists (rare for your wells)
  return String(ints[0]);
}

// Sort the dropdown options alphabetically & numerically
function sortDropdown() {
  const options = Array.from(resultsSelect.options);

  // Keep the first default option at the top
  const first = options.shift();

  options.sort((a, b) =>
    a.textContent.localeCompare(b.textContent, undefined, { numeric: true })
  );

  resultsSelect.innerHTML = "";
  resultsSelect.appendChild(first);
  options.forEach((opt) => resultsSelect.appendChild(opt));
}

// Smooth scroll to a given page and briefly highlight it
function scrollToPage(pageNum) {
  const pageEl = document.getElementById(`page-${pageNum}`);
  if (!pageEl) return;

  pageEl.scrollIntoView({ behavior: "smooth", block: "start" });

  pageEl.classList.add("highlight");
  setTimeout(() => {
    pageEl.classList.remove("highlight");
  }, 1000);
}

function jumpToPageAndSelect(pageNum) {
  scrollToPage(pageNum);

  // Highlight corresponding dropdown option if it exists
  for (const opt of resultsSelect.options) {
    if (Number(opt.value) === pageNum) {
      resultsSelect.value = opt.value;
      break;
    }
  }
}

// ---------- PDF Loading & Indexing ----------

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  setStatus("Loading PDF...");
  numberIndex.clear();
  lastSearchKey = null;
  lastSearchIndex = 0;

  resultsSelect.innerHTML =
    '<option value="">Names found (optional quick jump)...</option>';
  pdfContainer.innerHTML = "";

  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdfDoc = await loadingTask.promise;

    setStatus(`PDF loaded (${pdfDoc.numPages} pages). Rendering pages...`);
    await renderAllPages();

    setStatus("Indexing wells...");
    await buildNumberIndex();

    sortDropdown();

    // setStatus(
    //   `Ready. Pages: ${pdfDoc.numPages}. Number keys indexed: ${numberIndex.size}.`
    // );
  } catch (err) {
    console.error(err);
    setStatus("Error loading PDF");
  }
});

async function renderAllPages() {
  if (!pdfDoc) return;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: DEFAULT_SCALE });

    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page";
    wrapper.id = `page-${pageNum}`;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // Render at higher internal resolution for clarity
    canvas.width = viewport.width * OUTPUT_SCALE;
    canvas.height = viewport.height * OUTPUT_SCALE;

    // But display at normal CSS size (zoomed-out)
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    wrapper.appendChild(canvas);
    pdfContainer.appendChild(wrapper);

    const renderContext = {
      canvasContext: ctx,
      viewport,
      transform:
        OUTPUT_SCALE !== 1 ? [OUTPUT_SCALE, 0, 0, OUTPUT_SCALE, 0, 0] : undefined,
    };

    await page.render(renderContext).promise;
  }
}


// Go through each page and look for "Name: ..." and extract the well name,
// then build a map from numeric key (e.g. "10-28") to page numbers.
async function buildNumberIndex() {
  if (!pdfDoc) return;

  const seenNameOnPage = new Set();

  // To strip off things like "November 2025" from header lines if they sneak in
  const monthRegex =
    /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{4}\b/i;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();

    // All text on the page in one string
    const text = content.items.map((item) => item.str).join(" ");

    const NAME = "Name:";
    let searchPos = 0;

    while (true) {
      const idx = text.indexOf(NAME, searchPos);
      if (idx === -1) break;

      // Everything after "Name:"
      let after = text.slice(idx + NAME.length);

      // Cut at "GAS VOLUME STATEMENT" if it exists (header)
      const gasIdx = after.indexOf("GAS VOLUME STATEMENT");
      if (gasIdx !== -1) {
        after = after.slice(0, gasIdx);
      }

      let nameRaw = after;

      // Cut off "November 2025", etc. if present
      const monthMatch = monthRegex.exec(nameRaw);
      if (monthMatch) {
        nameRaw = nameRaw.slice(0, monthMatch.index);
      }

      nameRaw = nameRaw.trim();
      if (!nameRaw) {
        searchPos = idx + NAME.length;
        continue;
      }

      // Example nameRaw: "HILL CREEK UNIT 10-28F"
      const key = getNumberKeyFromText(nameRaw);
      if (!key) {
        searchPos = idx + NAME.length;
        continue;
      }

      // Update index: numeric key -> list of pages
      if (!numberIndex.has(key)) {
        numberIndex.set(key, []);
      }
      const pages = numberIndex.get(key);
      if (!pages.includes(pageNum)) {
        pages.push(pageNum);
      }

      // Add one dropdown option per (page, well name)
      const uniqueNameKey = `${pageNum}::${nameRaw}`;
      if (!seenNameOnPage.has(uniqueNameKey)) {
        seenNameOnPage.add(uniqueNameKey);

        const opt = document.createElement("option");
        opt.value = String(pageNum);
        opt.textContent = `${nameRaw} (page ${pageNum})`;
        resultsSelect.appendChild(opt);
      }

      // Move past this "Name:" in case there's another on the same page
      searchPos = idx + NAME.length;
    }
  }
}

// ---------- Search (numbers only) ----------

function doSearch() {
  if (!pdfDoc) {
    setStatus("Load a PDF first.");
    return;
  }

  const query = searchInput.value.trim();
  if (!query) return;

  // Only use the numeric parts of whatever the user typed
  const key = getNumberKeyFromText(query);
  if (!key) {
    setStatus('Please search using numbers like "10-28" or "1-29".');
    return;
  }

  const pages = numberIndex.get(key);
  if (!pages || pages.length === 0) {
    setStatus(`No wells found for "${key}".`);
    return;
  }

  // Cycle through pages if same numeric key is searched again
  if (key === lastSearchKey) {
    lastSearchIndex = (lastSearchIndex + 1) % pages.length;
  } else {
    lastSearchKey = key;
    lastSearchIndex = 0;
  }

  const pageNum = pages[lastSearchIndex];
  setStatus(
    `Showing ${key}: match ${lastSearchIndex + 1} of ${pages.length} (page ${pageNum}).`
  );
  jumpToPageAndSelect(pageNum);
}

// Events
searchBtn.addEventListener("click", doSearch);

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    doSearch();
  }
});

// Prevent arrow keys in dropdown from auto-jumping pages
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

// Jump only when the user actually chooses with mouse / touch
resultsSelect.addEventListener("change", (e) => {
  if (suppressSelectJump) {
    // Ignore jumps caused by arrow-key navigation in the select
    suppressSelectJump = false;
    return;
  }

  const value = e.target.value;
  if (!value) return;
  const pageNum = parseInt(value, 10);
  if (pageNum) {
    jumpToPageAndSelect(pageNum);
  }
});

