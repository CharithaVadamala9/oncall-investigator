const transcript = document.getElementById("transcript");
const statusEl = document.getElementById("status");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");

function getSessionId() {
  const key = "investigator-session-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function appendMessage(className, content, isHtml = false) {
  const el = document.createElement("div");
  el.className = `msg ${className}`;
  if (isHtml) {
    el.innerHTML = content;
  } else {
    el.textContent = content;
  }
  transcript.appendChild(el);
  transcript.scrollTop = transcript.scrollHeight;
  return el;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") // must run before the italic pass below,
    .replace(/\*(.+?)\*/g, "<em>$1</em>") // or stray ** pairs confuse the single-* match
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function listKind(lines) {
  if (lines.every((line) => /^[-*]\s/.test(line))) return "ul";
  if (lines.every((line) => /^\d+\.\s/.test(line))) return "ol";
  return null;
}

function renderBlockLines(lines) {
  const kind = listKind(lines);
  if (kind === "ul") {
    const items = lines.map((line) => `<li>${renderInline(line.replace(/^[-*]\s/, ""))}</li>`);
    return `<ul>${items.join("")}</ul>`;
  }
  if (kind === "ol") {
    const items = lines.map((line) => `<li>${renderInline(line.replace(/^\d+\.\s/, ""))}</li>`);
    return `<ol>${items.join("")}</ol>`;
  }
  return `<p>${lines.map(renderInline).join("<br>")}</p>`;
}

function renderBlock(lines) {
  const headingMatch = lines[0].match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    const level = Math.min(headingMatch[1].length + 2, 6);
    const heading = `<h${level}>${renderInline(headingMatch[2])}</h${level}>`;
    const rest = lines.slice(1);
    return rest.length ? heading + renderBlockLines(rest) : heading;
  }
  return renderBlockLines(lines);
}

// Small, dependency-free subset: headers, bold, inline code, bullet/numbered
// lists, paragraphs. Not a full markdown parser — just enough for the shape
// of answer Claude actually produces. Headers are checked per-line, not
// per-block, since Claude often writes
// "## Header" immediately followed by body text rather than its own
// blank-line-separated block. Adjacent blocks of the same list type are
// merged before rendering — Claude sometimes blank-line-separates list
// items instead of keeping them as one contiguous list, which without this
// merge step would render as N separate single-item lists.
function renderMarkdown(text) {
  const rawBlocks = text
    .split(/\n\n+/)
    .map((block) => block.split("\n").filter((line) => line.length > 0))
    .filter((lines) => lines.length > 0);

  const merged = [];
  for (const lines of rawBlocks) {
    const kind = listKind(lines);
    const prev = merged[merged.length - 1];
    if (kind && prev?.kind === kind) {
      prev.lines.push(...lines);
    } else {
      merged.push({ kind, lines });
    }
  }

  return merged.map(({ lines }) => renderBlock(lines)).join("");
}

function setBusy(busy) {
  input.disabled = busy;
  sendButton.disabled = busy;
}

const sessionId = getSessionId();
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(`${protocol}//${location.host}/agents/investigator/${sessionId}`);

ws.addEventListener("open", () => {
  statusEl.textContent = "connected";
});

ws.addEventListener("close", () => {
  statusEl.textContent = "disconnected";
  setBusy(true);
});

ws.addEventListener("error", () => {
  statusEl.textContent = "connection error";
});

ws.addEventListener("message", (event) => {
  let parsed;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return;
  }

  switch (parsed.type) {
    case "info":
      statusEl.textContent = parsed.message;
      break;
    case "tool_call":
      appendMessage("tool", `→ ${parsed.name}(${JSON.stringify(parsed.input)})`);
      break;
    case "tool_result": {
      const preview = JSON.stringify(parsed.result).slice(0, 200);
      appendMessage("tool", `✓ ${parsed.name} → ${preview}`);
      break;
    }
    case "answer":
      appendMessage("answer", renderMarkdown(parsed.text), true);
      setBusy(false);
      input.focus();
      break;
    case "error":
      appendMessage("error", parsed.message);
      setBusy(false);
      input.focus();
      break;
    default:
      // Agents SDK internal messages (e.g. cf_agent_state) — not part of
      // our protocol, nothing to render.
      break;
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;

  appendMessage("user", text);
  ws.send(text);
  input.value = "";
  setBusy(true);
});

// --- Weekly digest panel ---
// A frontend-only addition on top of the existing /admin/generate-summary
// and /admin/summaries routes — no new backend logic. SummaryAgent already
// runs on its own 5-minute schedule once started, so the "new digest"
// notification below is genuine: it fires when the background scheduler
// produces something while the tab is open, not a fake alert.

const digestBtn = document.getElementById("digestBtn");
const digestOverlay = document.getElementById("digestOverlay");
const digestPanel = document.getElementById("digestPanel");
const digestClose = document.getElementById("digestClose");
const digestGenerate = document.getElementById("digestGenerate");
const digestContent = document.getElementById("digestContent");
const digestHistory = document.getElementById("digestHistory");
const toast = document.getElementById("toast");

const LAST_SEEN_DIGEST_KEY = "investigator-last-seen-digest-id";
const DIGEST_POLL_INTERVAL_MS = 30000;

function getLastSeenDigestId() {
  return Number(localStorage.getItem(LAST_SEEN_DIGEST_KEY) || 0);
}

function markDigestSeen(id) {
  if (id) localStorage.setItem(LAST_SEEN_DIGEST_KEY, String(id));
}

function formatDigestMeta(count) {
  return `${count} investigation${count === 1 ? "" : "s"} reviewed`;
}

function renderHistoryItem(summary) {
  const when = new Date(summary.timestamp).toLocaleString();
  return `
    <details class="digest-item">
      <summary>${escapeHtml(when)} — ${formatDigestMeta(summary.incidentCount)}</summary>
      <div class="digest-item-body">${renderMarkdown(summary.summary)}</div>
    </details>
  `;
}

async function loadDigestHistory() {
  const response = await fetch("/admin/summaries");
  const summaries = await response.json();
  digestHistory.innerHTML = summaries.length
    ? summaries.map(renderHistoryItem).join("")
    : '<p class="digest-empty">No digests yet.</p>';
  if (summaries.length > 0) markDigestSeen(summaries[0].id);
  return summaries;
}

function openDigestPanel() {
  digestOverlay.classList.add("open");
  digestPanel.classList.add("open");
  loadDigestHistory().catch(() => {
    digestHistory.innerHTML = '<p class="digest-error">Failed to load digest history.</p>';
  });
}

function closeDigestPanel() {
  digestOverlay.classList.remove("open");
  digestPanel.classList.remove("open");
}

digestBtn.addEventListener("click", openDigestPanel);
digestClose.addEventListener("click", closeDigestPanel);
digestOverlay.addEventListener("click", closeDigestPanel);

digestGenerate.addEventListener("click", async () => {
  digestGenerate.disabled = true;
  digestContent.innerHTML = '<p class="digest-loading">Generating…</p>';
  try {
    const response = await fetch("/admin/generate-summary", { method: "POST" });
    const data = await response.json();
    digestContent.innerHTML = `<div class="digest-meta">${formatDigestMeta(data.incidentCount)}</div>${renderMarkdown(data.summary)}`;
    await loadDigestHistory();
  } catch (err) {
    digestContent.innerHTML = `<p class="digest-error">Failed to generate: ${escapeHtml(String(err))}</p>`;
  } finally {
    digestGenerate.disabled = false;
  }
});

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  toast.onclick = () => {
    toast.classList.remove("visible");
    openDigestPanel();
  };
  setTimeout(() => toast.classList.remove("visible"), 8000);
}

async function pollForNewDigest() {
  try {
    const response = await fetch("/admin/summaries");
    const summaries = await response.json();
    if (summaries.length === 0) return;
    const latest = summaries[0];
    if (latest.id > getLastSeenDigestId()) {
      showToast(`New weekly digest available — ${formatDigestMeta(latest.incidentCount)}`);
      markDigestSeen(latest.id);
    }
  } catch {
    // best-effort — a failed poll just tries again next interval
  }
}

// Seed "last seen" on first load so pre-existing digests don't trigger an
// immediate toast — only digests generated *after* this page connected should.
fetch("/admin/summaries")
  .then((r) => r.json())
  .then((summaries) => {
    if (summaries.length > 0 && !localStorage.getItem(LAST_SEEN_DIGEST_KEY)) {
      markDigestSeen(summaries[0].id);
    }
  })
  .catch(() => {});

setInterval(pollForNewDigest, DIGEST_POLL_INTERVAL_MS);
