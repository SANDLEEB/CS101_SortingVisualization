/* ============================================================
   engine.js — the shared "record first, then replay" engine.

   How it works:
   1. A sorting function runs ONCE and saves a list of "steps"
      (a snapshot of the array + what is happening) using Recorder.
   2. SortPage plays those steps forward and backward, drawing
      bars, code, messages, counters and the pass history table.
   ============================================================ */

/* ---------- 1. Recorder: used by each algorithm to save steps ---------- */

class Recorder {
  constructor(array) {
    this.arr = array.slice();             // the array we are sorting
    this.ids = array.map((_, i) => i);    // a fixed name for each bar, so bars can slide when swapped
    this.steps = [];
    this.comparisons = 0;
    this.swaps = 0;
    this.pass = null;    // pass number (or level for merge sort); null shows as "–"
    this.phase = null;   // e.g. "Splitting" / "Merging" (merge sort only)
  }

  // Count one comparison (call this every time two numbers are compared)
  compare() {
    this.comparisons++;
  }

  // Swap two positions in the array and count it
  swap(i, j) {
    [this.arr[i], this.arr[j]] = [this.arr[j], this.arr[i]];
    [this.ids[i], this.ids[j]] = [this.ids[j], this.ids[i]];
    this.swaps++;
  }

  // Save one step. Anything not given gets a sensible empty value.
  step({ codeLine, message, highlight = {}, markers = [], history = null, extra = null }) {
    this.steps.push({
      array: this.arr.slice(),
      ids: this.ids.slice(),
      highlight: {
        comparing: [], swapping: [], sorted: [],
        pivot: null, range: null, key: null,
        boundary: null,   // draw a dashed "sorted | unsorted" line before this index
        outlined: [],     // extra outline for special bars (e.g. "current smallest")
        pivotLine: null,  // draw a dashed line across the bars at this value's height
        ...highlight,
      },
      markers,            // small labels under the index boxes: [{ index, text }]
      codeLine,
      pass: this.pass,
      phase: this.phase,
      message,
      comparisons: this.comparisons,
      swaps: this.swaps,
      history,            // when a pass ends: { label, array, sorted, changed, note }
      extra,              // anything a page wants to draw in its own panels (tree, to-do list…)
    });
  }
}

/* ---------- 2. Checking the numbers a student types ---------- */

const MIN_COUNT = 4;
const MAX_COUNT = 12;
const MAX_VALUE = 99;

function parseNumbers(text) {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0) {
    return { ok: false, error: "Please type some numbers, like 5, 3, 8, 1" };
  }
  for (const p of parts) {
    if (/^-\d+$/.test(p)) {
      return { ok: false, error: `${p} is below zero. Please use numbers from 0 to ${MAX_VALUE}.` };
    }
    if (!/^\d+$/.test(p)) {
      return { ok: false, error: `"${p}" is not a whole number. Use numbers like 5, 3, 8, 1` };
    }
    if (Number(p) > MAX_VALUE) {
      return { ok: false, error: `${p} is too big. Please use numbers from 0 to ${MAX_VALUE}.` };
    }
  }
  if (parts.length < MIN_COUNT) {
    return { ok: false, error: `Please type at least ${MIN_COUNT} numbers (you typed ${parts.length}).` };
  }
  if (parts.length > MAX_COUNT) {
    return { ok: false, error: `Please type at most ${MAX_COUNT} numbers (you typed ${parts.length}).` };
  }
  return { ok: true, numbers: parts.map(Number) };
}

function randomArray(length = 8) {
  return Array.from({ length }, () => 5 + Math.floor(Math.random() * 55));
}

/* ---------- 3. SortPage: builds the page and replays the steps ---------- */

const LEGEND = [
  { cls: "gray",   symbol: "",  text: "Not looked at yet" },
  { cls: "yellow", symbol: "?", text: "Being compared" },
  { cls: "red",    symbol: "⇄", text: "Being swapped / moved" },
  { cls: "green",  symbol: "✓", text: "In final sorted place" },
  { cls: "purple", symbol: "P", text: "Pivot (quick sort)" },
  { cls: "blue",   symbol: "",  text: "Current part we are working on (merge / quick)" },
];

const SPEEDS = [
  { label: "Very slow", ms: 3000 },
  { label: "Slow",      ms: 2000 },
  { label: "Medium",    ms: 1200 },
  { label: "Fast",      ms: 700 },
  { label: "Very fast", ms: 300 },
];
const DEFAULT_SPEED = 1; // "Slow"

const SortPage = {
  /*
    config = {
      title, bigIdea (HTML),
      code: array of C++ lines. A line can also be { text, joinAbove: true }:
        it lights up together with the line above (for a loop body spread over lines),

      call: the C++ line that runs the sort, e.g. "selectionSort(arr);",
      record(array) -> steps, defaultArray,
      passLabel ("Pass"), swapLabel ("Swaps"),
      extraLegend: [{ symbol, text }],
      boundaryLabels: ["← sorted", "unsorted →"],
      phaseLabel: "Phase" (adds a 5th counter showing step.phase; leave out for no phase),
      defaultSpeed: 0–4 (index into SPEEDS),
      historyTitle: heading for the history table (default "<passLabel> history — …"),
      panels: [{ title, render(step, element, page) }]
        extra full-width cards shown under the history table (merge tree, to-do list…)
    }
  */
  init(config) {
    this.config = Object.assign({
      passLabel: "Pass", swapLabel: "Swaps", extraLegend: [],
      boundaryLabels: ["← sorted", "unsorted →"],
      phaseLabel: null, defaultSpeed: DEFAULT_SPEED, panels: [],
    }, config);
    this.steps = [];
    this.current = 0;
    this.timer = null;
    this.speed = this.config.defaultSpeed;
    this.buildLayout();
    this.loadArray(this.config.defaultArray || randomArray());
  },

  /* ----- Build all the HTML once ----- */
  buildLayout() {
    const c = this.config;
    const legendHtml = LEGEND.map((l) =>
      `<span class="legend-item"><span class="swatch" style="background:var(--${l.cls})">${l.symbol}</span>${l.text}</span>`
    ).concat(c.extraLegend.map((l) =>
      `<span class="legend-item"><span class="swatch" style="background:#fff">${l.symbol}</span>${l.text}</span>`
    )).join("");

    const codeHtml = c.code.map((line) => typeof line === "string"
      ? `<li>${escapeHtml(line)}</li>`
      : `<li class="${line.joinAbove ? "join-above" : ""}">${escapeHtml(line.text)}</li>`
    ).join("");
    const exampleButton = c.defaultArray
      ? `<button id="b-example" title="Go back to this page's example numbers">↺ Example array</button>` : "";

    const panelHtml = c.panels.map((p, i) =>
      `<section class="card panel"><h2>${p.title}</h2><div id="panel-${i}"></div></section>`
    ).join("");
    const phaseCounter = c.phaseLabel
      ? `<div class="counter"><div class="label">${c.phaseLabel}</div><div class="value" id="c-phase">–</div></div>`
      : "";

    // Page order: controls on top, then bars + code, explanation and
    // history together with nothing in between. Extra panels and the big idea come after.
    document.getElementById("app").innerHTML = `
      <header class="top">
        <a class="home-link" href="index.html">← Home</a>
        <h1>${c.title}</h1>
      </header>

      <section class="card controls-card">
        <div class="controls">
          <button id="b-restart" title="Go back to the start">⏮ Restart</button>
          <button id="b-back" title="Go one step back (← key)">◀ Step back</button>
          <button id="b-play" class="primary" title="Play or pause (space bar)">▶ Play</button>
          <button id="b-forward" title="Go one step forward (→ key)">Step forward ▶</button>
          <label class="speed">Speed:
            <input type="range" id="speed" min="0" max="${SPEEDS.length - 1}" value="${this.speed}">
            <span id="speed-label"></span>
          </label>
        </div>
        <div class="custom-input">
          ${exampleButton}
          <button id="b-random">🎲 New random array</button>
          <input type="text" id="custom" placeholder="e.g. 5,3,8,1" aria-label="Your own numbers">
          <button id="b-custom">Use my numbers</button>
          <span class="hint">${MIN_COUNT}–${MAX_COUNT} whole numbers from 0 to ${MAX_VALUE}</span>
        </div>
        <div class="input-error" id="input-error" role="alert"></div>
        <div class="legend" aria-label="Color guide">${legendHtml}</div>
      </section>

      <div class="main-grid">
        <div>
          <section class="card">
            <div class="counters">
              <div class="counter"><div class="label">${c.passLabel}</div><div class="value" id="c-pass">–</div></div>
              ${phaseCounter}
              <div class="counter"><div class="label">Step</div><div class="value" id="c-step">–</div></div>
              <div class="counter"><div class="label">Comparisons</div><div class="value" id="c-comp">0</div></div>
              <div class="counter"><div class="label">${c.swapLabel}</div><div class="value" id="c-swap">0</div></div>
            </div>
            <div class="array-view">
              <div class="bars" id="bars"></div>
              <div class="index-row" id="index-row"></div>
              <div class="marker-row" id="marker-row"></div>
            </div>
          </section>

          <section class="card explain" id="explain" aria-live="polite"></section>
        </div>

        <section class="card">
          <h2>The code (C++)</h2>
          <p class="code-note">The array we are sorting (change it with the buttons above):</p>
          <pre class="code code-setup" id="code-setup"></pre>
          <ol class="code" id="code">${codeHtml}</ol>
          <p class="code-note"><code>vector&lt;int&gt;</code> is C++ for "a list of whole numbers".
          <code>arr.size()</code> means "how many numbers are in arr".</p>
        </section>
      </div>

      <section class="card">
        <h2>${c.historyTitle || `${c.passLabel} history — the array after each ${c.passLabel.toLowerCase()}`}</h2>
        <div class="history-wrap" id="history"></div>
      </section>

      ${panelHtml}

      <section class="card big-idea"><h2>💡 Big idea</h2>${c.bigIdea}</section>
    `;

    // Wire up the buttons
    const $ = (id) => document.getElementById(id);
    $("b-restart").onclick = () => { this.pause(); this.show(0); };
    $("b-back").onclick = () => { this.pause(); this.show(this.current - 1); };
    $("b-forward").onclick = () => { this.pause(); this.show(this.current + 1); };
    $("b-play").onclick = () => (this.timer ? this.pause() : this.play());
    if (c.defaultArray) {
      $("b-example").onclick = () => { $("input-error").textContent = ""; this.loadArray(c.defaultArray); };
    }
    $("b-random").onclick = () => { $("input-error").textContent = ""; this.loadArray(randomArray()); };
    $("b-custom").onclick = () => this.useCustomInput();
    $("custom").onkeydown = (e) => { if (e.key === "Enter") this.useCustomInput(); };
    $("speed").oninput = (e) => { this.speed = Number(e.target.value); this.updateSpeedLabel(); };
    this.updateSpeedLabel();

    // Lines that are just a closing "}" are shown but never highlighted,
    // so step.codeLine counts only the other lines (1 = first line, 2 = next counted line…).
    // Each counted line keeps a list of the lines that light up with it.
    this.codeLineEls = [];
    document.querySelectorAll("#code li").forEach((li) => {
      if (li.classList.contains("join-above")) this.codeLineEls[this.codeLineEls.length - 1].push(li);
      else if (!/^\s*}\s*$/.test(li.textContent)) this.codeLineEls.push([li]);
    });

    // Keyboard shortcuts (not while typing in the text box)
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" && e.target.type === "text") return;
      if (e.key === "ArrowRight") { this.pause(); this.show(this.current + 1); }
      else if (e.key === "ArrowLeft") { this.pause(); this.show(this.current - 1); }
      else if (e.key === " ") { e.preventDefault(); this.timer ? this.pause() : this.play(); }
    });
  },

  updateSpeedLabel() {
    document.getElementById("speed-label").textContent = SPEEDS[this.speed].label;
  },

  useCustomInput() {
    const result = parseNumbers(document.getElementById("custom").value);
    const errorBox = document.getElementById("input-error");
    if (!result.ok) {
      errorBox.textContent = "🙂 " + result.error;
      return;
    }
    errorBox.textContent = "";
    this.loadArray(result.numbers);
  },

  /* ----- Record all steps for a new array, then build the bars ----- */
  loadArray(array) {
    this.pause();
    this.steps = this.config.record(array.slice());
    this.n = array.length;

    const bars = document.getElementById("bars");
    bars.innerHTML = "";
    this.barEls = array.map(() => {
      const el = document.createElement("div");
      el.className = "bar";
      el.innerHTML = `<div class="fill"><span class="num"></span><span class="tag"></span></div>`;
      bars.appendChild(el);
      return el;
    });
    this.boundaryEl = document.createElement("div");
    this.boundaryEl.className = "boundary";
    const [leftLabel, rightLabel] = this.config.boundaryLabels;
    this.boundaryEl.innerHTML = `<span class="side left">${leftLabel}</span><span class="side right">${rightLabel}</span>`;
    bars.appendChild(this.boundaryEl);
    this.pivotLineEl = document.createElement("div");
    this.pivotLineEl.className = "pivot-line";
    this.pivotLineEl.innerHTML = `<span class="pivot-label"></span>`;
    bars.appendChild(this.pivotLineEl);

    const cols = `repeat(${this.n}, 1fr)`;
    const indexRow = document.getElementById("index-row");
    indexRow.style.gridTemplateColumns = cols;
    indexRow.innerHTML = array.map((_, i) =>
      `<div class="index-box"><span class="idx-label">index</span><span class="idx-num">${i}</span></div>`
    ).join("");
    document.getElementById("marker-row").style.gridTemplateColumns = cols;

    // Show the array as C++ above the code, and put it in the text box so students can edit it
    document.getElementById("code-setup").textContent =
      `vector<int> arr = {${array.join(", ")}};\n${this.config.call}`;
    document.getElementById("custom").value = array.join(", ");

    this.maxValue = Math.max(...array, 1);
    this.show(0);
  },

  /* ----- Draw step number k ----- */
  show(k) {
    k = Math.max(0, Math.min(this.steps.length - 1, k));
    this.current = k;
    const step = this.steps[k];
    const h = step.highlight;
    const n = this.n;

    // Bars: each bar keeps its own element, so it slides when it changes position
    step.ids.forEach((id, pos) => {
      const el = this.barEls[id];
      const value = step.array[pos];
      el.style.left = (pos * 100) / n + "%";
      el.style.width = 100 / n + "%";
      el.style.height = this.barHeight(value) + "px";
      el.querySelector(".num").textContent = value;

      let cls = "", tag = "";
      if (h.swapping.includes(pos))       { cls = "swapping";  tag = "⇄"; }
      else if (h.comparing.includes(pos)) { cls = "comparing"; tag = "?"; }
      else if (h.pivot === pos)           { cls = "pivot";     tag = "P"; }
      else if (h.sorted.includes(pos))    { cls = "sorted";    tag = "✓"; }
      else if (h.range && pos >= h.range[0] && pos <= h.range[1]) { cls = "in-range"; }
      if (h.key === pos && !tag) tag = "✋";

      const outside = h.range && (pos < h.range[0] || pos > h.range[1]) && !h.sorted.includes(pos);
      el.className = "bar " + cls +
        (outside ? " faded" : "") +
        (h.key === pos ? " key" : "") +
        (h.outlined.includes(pos) ? " outlined" : "");
      el.querySelector(".tag").textContent = tag;
    });

    // Sorted | unsorted dashed line
    if (h.boundary === null || h.boundary === undefined) {
      this.boundaryEl.style.display = "none";
    } else {
      this.boundaryEl.style.display = "";
      this.boundaryEl.style.left = (h.boundary * 100) / n + "%";
      this.boundaryEl.querySelector(".left").style.display = h.boundary > 0 ? "" : "none";
      this.boundaryEl.querySelector(".right").style.display = h.boundary < n ? "" : "none";
    }

    // Dashed line at the pivot's height (quick sort)
    if (h.pivotLine === null || h.pivotLine === undefined) {
      this.pivotLineEl.style.display = "none";
    } else {
      this.pivotLineEl.style.display = "";
      this.pivotLineEl.style.bottom = this.barHeight(h.pivotLine) + "px";
      this.pivotLineEl.querySelector(".pivot-label").textContent = `pivot = ${h.pivotLine}`;
    }

    // Labels under the index boxes (e.g. "▲ smallest")
    const markerText = Array(n).fill("");
    step.markers.forEach((m) => { markerText[m.index] = m.text; });
    document.getElementById("marker-row").innerHTML =
      markerText.map((t) => `<div class="marker">${t}</div>`).join("");

    // Code line
    this.codeLineEls.forEach((group, i) => {
      group.forEach((li) => li.classList.toggle("current", i + 1 === step.codeLine));
    });

    // Message and counters
    document.getElementById("explain").textContent = step.message;
    document.getElementById("c-pass").textContent = step.pass ?? "–";
    if (this.config.phaseLabel) document.getElementById("c-phase").textContent = step.phase ?? "–";
    document.getElementById("c-step").textContent = `${k + 1} of ${this.steps.length}`;
    document.getElementById("c-comp").textContent = step.comparisons;
    document.getElementById("c-swap").textContent = step.swaps;

    // Buttons
    document.getElementById("b-back").disabled = k === 0;
    document.getElementById("b-restart").disabled = k === 0;
    document.getElementById("b-forward").disabled = k === this.steps.length - 1;

    this.renderHistory();

    // Extra panels the page asked for (merge tree, quick sort to-do list…)
    this.config.panels.forEach((p, i) => p.render(step, document.getElementById("panel-" + i), this));
  },

  // Bar height in pixels for a value (also used for the pivot line)
  barHeight(value) {
    return 40 + (value / this.maxValue) * 250;
  },

  /* ----- Pass history: only rows up to the current step, so step back removes rows ----- */
  renderHistory() {
    const rows = this.steps.slice(0, this.current + 1).filter((s) => s.history).map((s) => s.history);
    const head = `<tr><th></th>${Array.from({ length: this.n }, (_, i) => `<th>index ${i}</th>`).join("")}<th>What happened</th></tr>`;
    const body = rows.map((r) => {
      const cells = r.array.map((v, i) => {
        const cls = [(r.sorted || []).includes(i) ? "done" : "", (r.changed || []).includes(i) ? "changed" : ""].join(" ").trim();
        const mark = (r.sorted || []).includes(i) ? " ✓" : "";
        return `<td class="${cls}">${v}${mark}</td>`;
      }).join("");
      return `<tr><td class="row-label">${r.label}</td>${cells}<td class="note">${r.note || ""}</td></tr>`;
    }).join("");
    document.getElementById("history").innerHTML = `<table class="history">${head}${body}</table>`;
  },

  /* ----- Play / pause ----- */
  play() {
    if (this.current >= this.steps.length - 1) this.show(0); // at the end? start over
    document.getElementById("b-play").textContent = "⏸ Pause";
    const tick = () => {
      if (this.current >= this.steps.length - 1) { this.pause(); return; }
      this.show(this.current + 1);
      this.timer = setTimeout(tick, SPEEDS[this.speed].ms);
    };
    this.timer = setTimeout(tick, SPEEDS[this.speed].ms / 3);
  },

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    const btn = document.getElementById("b-play");
    if (btn) btn.textContent = "▶ Play";
  },
};

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Lets the test scripts load this file in Node (ignored in the browser)
if (typeof module !== "undefined") {
  module.exports = { Recorder, parseNumbers, randomArray };
}
