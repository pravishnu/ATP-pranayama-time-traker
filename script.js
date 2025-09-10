/* Pranayama Breath Timer - Combined Final Script
   Features:
   - Custom durations
   - Voice guidance
   - Start / Pause / Reset
   - Track sessionCycles, sessionStart/end
   - History (per-phase logs) persisted in localStorage
   - Session summaries persisted in localStorage
   - Progress (cycles per day) chart via Chart.js persisted in localStorage
   - Download history (.txt), download chart (PNG), export full PDF (jsPDF) w/ date-range filter
*/

/////////////////////// Elements ///////////////////////
const inhaleInput = document.getElementById("inhaleInput");
const holdInput = document.getElementById("holdInput");
const exhaleInput = document.getElementById("exhaleInput");

const phaseDisplay = document.getElementById("phase");
const timeDisplay = document.getElementById("time");

const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resetBtn = document.getElementById("resetBtn");

const downloadBtn = document.getElementById("downloadBtn");
const downloadChartBtn = document.getElementById("downloadChartBtn");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const reportRange = document.getElementById("reportRange");

const historyList = document.getElementById("historyList");
const chartCanvas = document.getElementById("historyChart");

/////////////////////// State ///////////////////////
let cycle = [];
let cycleIndex = 0;
let timeLeft = 0;
let timerId = null;
let running = false;
let paused = false;

// Session tracking
let sessionStartTime = null;
let sessionCycles = 0; // full inhale-hold-exhale cycles completed in current session
let sessionActive = false;

// Data persistence
let historyData = [];     // array of {ts: ISO, phase: string, duration: number, text: string}
let sessionSummaries = []; // array of {startISO, endISO, cycles, durationSec, inhale,hold,exhale}
let progressData = {};    // { "YYYY-MM-DD": number } -> completed full cycles per day

// Chart instance
let chart = null;

/////////////////////// Utilities ///////////////////////
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch (e) {
    // ignore speech errors
  }
}

function nowISO() { return new Date().toISOString(); }
function formatLocale(tsISO) {
  try { return new Date(tsISO).toLocaleString(); } catch { return tsISO; }
}
function dateKeyFromISO(tsISO) {
  const d = new Date(tsISO);
  return d.toLocaleDateString(); // depends on user's locale; consistent with display
}

/////////////////////// Persistence ///////////////////////
function loadFromStorage(){
  // historyData
  const h = localStorage.getItem("pranayama_history_v2");
  if (h) {
    try {
      const parsed = JSON.parse(h);
      // handle old string array fallback
      historyData = parsed.map(item => {
        if (typeof item === "string") {
          // format was "date - phase (Xs)"
          const ts = new Date().toISOString();
          return { ts, phase: item, duration: 0, text: item };
        }
        return item;
      });
    } catch { historyData = []; }
  }

  // sessionSummaries
  const s = localStorage.getItem("pranayama_sessions_v1");
  if (s) {
    try { sessionSummaries = JSON.parse(s); } catch { sessionSummaries = []; }
  }

  // progressData
  const p = localStorage.getItem("pranayama_progress_v1");
  if (p) {
    try { progressData = JSON.parse(p); } catch { progressData = {}; }
  }
}

function saveHistoryToStorage(){
  localStorage.setItem("pranayama_history_v2", JSON.stringify(historyData));
}
function saveSessionsToStorage(){
  localStorage.setItem("pranayama_sessions_v1", JSON.stringify(sessionSummaries));
}
function saveProgressToStorage(){
  localStorage.setItem("pranayama_progress_v1", JSON.stringify(progressData));
}

/////////////////////// UI Helpers ///////////////////////
function refreshHistoryUI(){
  historyList.innerHTML = "";
  historyData.slice().reverse().forEach(entry => {
    const li = document.createElement("li");
    li.textContent = `${formatLocale(entry.ts)} - ${entry.phase} (${entry.duration}s)`;
    historyList.appendChild(li);
  });
}

/////////////////////// Chart ///////////////////////
function buildChart(labels, values){
  if (chart) chart.destroy();
  chart = new Chart(chartCanvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Completed Full Cycles",
        data: values,
        backgroundColor: '#8b6f47'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { title: { display: true, text: "Date" } },
        y: { beginAtZero: true, title: { display: true, text: "Cycles" } }
      }
    }
  });
}

function updateChart(rangeValue = "all"){
  // Prepare dataset based on progressData and range
  const allDates = Object.keys(progressData).sort((a,b)=> new Date(a)-new Date(b));
  let labels = [];
  let values = [];

  if (rangeValue === "all") {
    labels = allDates;
  } else {
    // last N days
    const days = parseInt(rangeValue,10);
    const now = new Date();
    const cutoff = new Date(); cutoff.setDate(now.getDate() - (days - 1)); // include today
    labels = allDates.filter(d => {
      const di = new Date(d);
      return di >= new Date(cutoff.toDateString());
    });
  }

  // if no labels, show last 7 days by default to give context
  if (labels.length === 0) {
    // Build last 7 days labels
    const arr = [];
    for (let i=6;i>=0;i--){
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      arr.push(dt.toLocaleDateString());
    }
    labels = arr;
  }

  values = labels.map(l => progressData[l] || 0);

  buildChart(labels, values);
}

/////////////////////// Core Timer Logic ///////////////////////
function setupCycleFromInputs(){
  const inhale = Math.max(1, parseInt(inhaleInput.value) || 4);
  const hold = Math.max(1, parseInt(holdInput.value) || 7);
  const exhale = Math.max(1, parseInt(exhaleInput.value) || 8);
  cycle = [
    { phase: "Inhale", duration: inhale },
    { phase: "Hold", duration: hold },
    { phase: "Exhale", duration: exhale }
  ];
}

function startCycle(){
  if (running) return;
  setupCycleFromInputs();
  running = true;
  paused = false;
  cycleIndex = 0;
  timeLeft = cycle[0].duration;
  // mark session start if not active
  if (!sessionActive) {
    sessionActive = true;
    sessionStartTime = new Date();
    sessionCycles = 0;
  }
  startPhase();
}

function startPhase(){
  const current = cycle[cycleIndex];
  phaseDisplay.textContent = current.phase;
  timeDisplay.textContent = String(current.duration).padStart(2,"0");
  timeLeft = current.duration;

  // voice
  speak(current.phase);

  clearInterval(timerId);
  timerId = setInterval(() => {
    if (paused) return;
    timeLeft--;
    timeDisplay.textContent = String(timeLeft).padStart(2,"0");
    if (timeLeft <= 0) {
      clearInterval(timerId);
      // log phase completion
      addHistoryPhase(current.phase, current.duration);
      // move to next
      cycleIndex = (cycleIndex + 1) % cycle.length;

      // If we completed exhale (i.e., just finished cycleIndex that is 0 again), that means one full cycle finished
      if (current.phase.toLowerCase() === "exhale") {
        sessionCycles++;
        addProgressForToday(1);
        // Save session progress instantly
        saveProgressToStorage();
        updateChart(reportRange.value);
      }

      // start next phase
      startPhase();
    }
  }, 1000);
}

function pauseOrResume(){
  if (!running) return;
  paused = !paused;
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  speak(paused ? "Paused" : "Resumed");
}

function resetCycle(){
  // finalize session if active
  finalizeSessionIfActive();

  clearInterval(timerId);
  running = false;
  paused = false;
  sessionActive = false;
  sessionStartTime = null;
  sessionCycles = 0;
  cycleIndex = 0;
  timeLeft = 0;
  phaseDisplay.textContent = "Press Start";
  timeDisplay.textContent = "00";
  pauseBtn.textContent = "Pause";
  speechSynthesis.cancel();
}

/////////////////////// History / Progress ///////////////////////
function addHistoryPhase(phase, duration){
  const entry = {
    ts: nowISO(),
    phase,
    duration,
    text: `${phase} (${duration}s)`
  };
  historyData.push(entry);
  saveHistoryToStorage();
  refreshHistoryUI();
}

function addProgressForToday(count){
  const key = (new Date()).toLocaleDateString();
  progressData[key] = (progressData[key] || 0) + count;
  saveProgressToStorage();
}

// Finalize session and store summary
function finalizeSessionIfActive(){
  if (!sessionActive) return;
  sessionActive = false;
  const end = new Date();
  const start = sessionStartTime || end;
  const durationSec = Math.round((end - start)/1000);
  const summary = {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    cycles: sessionCycles,
    durationSec,
    inhale: parseInt(inhaleInput.value) || 4,
    hold: parseInt(holdInput.value) || 7,
    exhale: parseInt(exhaleInput.value) || 8
  };
  sessionSummaries.push(summary);
  saveSessionsToStorage();
  // keep history & progress already saved
}

/////////////////////// Downloads & Exports ///////////////////////
function downloadHistoryTxt(){
  if (historyData.length === 0) {
    alert("No history to download.");
    return;
  }
  const lines = historyData.map(h => `${formatLocale(h.ts)} - ${h.phase} (${h.duration}s)`);
  const blob = new Blob([lines.join("\n")], {type:"text/plain"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pranayama_history.txt";
  a.click();
  URL.revokeObjectURL(url);
}

function downloadChartPNG(){
  if (!chart) {
    alert("No chart available.");
    return;
  }
  const link = document.createElement("a");
  link.href = chart.toBase64Image();
  link.download = "pranayama_progress.png";
  link.click();
}

// Filter history by range
function filterHistoryByRange(range){
  if (range === "all") return historyData.slice();
  const days = parseInt(range,10);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (days - 1)); // include today
  return historyData.filter(h => new Date(h.ts) >= new Date(cutoff.toDateString()));
}

// Filter progress data by range for chart in PDF (returns {label:count} sorted)
function filteredProgressForRange(range){
  const obj = {};
  Object.keys(progressData).forEach(k => obj[k] = progressData[k]);
  const arr = Object.keys(obj).sort((a,b) => new Date(a)-new Date(b));
  if (range === "all") {
    const out = {};
    arr.forEach(k => out[k] = obj[k]);
    return out;
  } else {
    const days = parseInt(range,10);
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (days - 1));
    const out = {};
    arr.forEach(k => {
      const d = new Date(k);
      if (d >= new Date(cutoff.toDateString())) out[k] = obj[k];
    });
    return out;
  }
}

async function exportFullPDF(){
  // If session running, show current session results live (do not force reset)
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF();

  const range = reportRange.value;
  const filteredHistory = filterHistoryByRange(range);
  const progFiltered = filteredProgressForRange(range);

  // Title & meta
  pdf.setFontSize(18);
  pdf.text("Pranayama Breath Timer Report", 14, 18);
  pdf.setFontSize(10);
  pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, 26);
  pdf.text(`Range: ${range === "all" ? "All Time" : `Last ${range} Days`}`, 14, 32);

  // Session summary (include active session data if present)
  pdf.setFontSize(12);
  pdf.text("Session Summary:", 14, 44);
  pdf.setFontSize(10);
  let y = 50;
  if (sessionActive || (sessionSummaries.length && sessionSummaries.length>0)) {
    // current live session if active
    if (sessionActive) {
      const start = sessionStartTime || new Date();
      const now = new Date();
      const durationMin = Math.round((now - start)/1000/60);
      pdf.text(`• Current (live) session started: ${formatLocale(start.toISOString())}`, 18, y); y+=6;
      pdf.text(`• Cycles completed (this session): ${sessionCycles}`, 18, y); y+=6;
      pdf.text(`• Session duration (approx): ${durationMin} min`, 18, y); y+=8;
    }
    // also show last saved session summary if any
    if (sessionSummaries.length){
      const last = sessionSummaries[sessionSummaries.length -1];
      pdf.text(`• Last saved session: ${formatLocale(last.startISO)} → ${formatLocale(last.endISO)}`, 18, y); y+=6;
      pdf.text(`  Cycles: ${last.cycles}, Duration: ${Math.round(last.durationSec/60)} min`, 18, y); y+=8;
    }
  } else {
    pdf.text("• No session data recorded yet.", 18, y); y+=8;
  }

  // Instructions block
  pdf.setFontSize(12);
  pdf.text("Instructions:", 14, y); y+=6;
  pdf.setFontSize(10);
  const instructions = [
    "• Sit comfortably in a quiet place.",
    "• Close your eyes & relax your body.",
    "• Follow the timer: Inhale → Hold → Exhale.",
    "• Use Pause/Reset controls as needed."
  ];
  instructions.forEach(line => { pdf.text(line, 18, y); y+=6; });
  y += 6;

  // History
  pdf.setFontSize(12);
  pdf.text("History (filtered):", 14, y); y+=6;
  pdf.setFontSize(10);
  if (filteredHistory.length === 0) {
    pdf.text("No history available for this range.", 18, y); y+=8;
  } else {
    filteredHistory.forEach((h, idx) => {
      if (y > 270) { pdf.addPage(); y = 18; }
      pdf.text(`${idx+1}. ${formatLocale(h.ts)} - ${h.phase} (${h.duration}s)`, 18, y);
      y+=6;
    });
    y+=6;
  }

  // Add chart image (if chart exists)
  if (chart) {
    // insert chart into PDF on new page
    try {
      const chartImg = chart.toBase64Image();
      pdf.addPage();
      pdf.setFontSize(12);
      pdf.text("Progress Chart (filtered):", 14, 20);
      pdf.addImage(chartImg, "PNG", 14, 28, 180, 90);
    } catch (e) {
      // fallback: write message
      pdf.addPage();
      pdf.text("Unable to embed chart image.", 14, 20);
    }
  }

  // Save
  pdf.save("pranayama_full_report.pdf");
}

/////////////////////// Clear history ///////////////////////
function clearAllHistory(){
  if (!confirm("Are you sure? This will clear all saved history, sessions, and progress.")) return;
  historyData = [];
  sessionSummaries = [];
  progressData = {};
  saveHistoryToStorage();
  saveSessionsToStorage();
  saveProgressToStorage();
  refreshHistoryUI();
  updateChart(reportRange.value);
}

/////////////////////// Events ///////////////////////
startBtn.addEventListener("click", startCycle);
pauseBtn.addEventListener("click", pauseOrResume);
resetBtn.addEventListener("click", resetCycle);

downloadBtn.addEventListener("click", downloadHistoryTxt);
downloadChartBtn.addEventListener("click", downloadChartPNG);
downloadPdfBtn.addEventListener("click", exportFullPDF);

clearHistoryBtn.addEventListener("click", clearAllHistory);

reportRange.addEventListener("change", () => {
  updateChart(reportRange.value);
});

/////////////////////// Boot ///////////////////////
(function init(){
  loadFromStorage();
  refreshHistoryUI();
  updateChart("all");
  // Ensure UI shows defaults
  phaseDisplay.textContent = "Press Start";
  timeDisplay.textContent = "00";
})();
