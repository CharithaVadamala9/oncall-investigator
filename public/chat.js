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
// of answer Claude actually produces (seen across every test run in Phase 8).
// Headers are checked per-line, not per-block, since Claude often writes
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
