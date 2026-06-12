const els = {
  status: document.querySelector("#status"),
  serverDot: document.querySelector("#serverDot"),
  serverStatus: document.querySelector("#serverStatus"),
  keyStatus: document.querySelector("#keyStatus"),
  proxyStatus: document.querySelector("#proxyStatus"),
  accessPanel: document.querySelector("#accessPanel"),
  accessCode: document.querySelector("#accessCode"),
  saveAccessBtn: document.querySelector("#saveAccessBtn"),
  accessStatus: document.querySelector("#accessStatus"),
  transcript: document.querySelector("#transcript"),
  startBtn: document.querySelector("#startBtn"),
  muteBtn: document.querySelector("#muteBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  sendMessageBtn: document.querySelector("#sendMessageBtn"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  searchBtn: document.querySelector("#searchBtn"),
  summarizeBtn: document.querySelector("#summarizeBtn"),
  copyNoteBtn: document.querySelector("#copyNoteBtn"),
  noteOutput: document.querySelector("#noteOutput"),
  companionName: document.querySelector("#companionName"),
  language: document.querySelector("#language"),
  style: document.querySelector("#style"),
  focus: document.querySelector("#focus"),
  meter: document.querySelector(".meter")
};

const storageKeys = {
  accessCode: "thoughtCompanionAccessCode",
  messages: "thoughtCompanionMessages",
  settings: "thoughtCompanionSettings",
  note: "thoughtCompanionLatestNote"
};

let pc;
let dc;
let localStream;
let remoteAudio;
let isMuted = false;
let currentAssistant;
let accessCode = localStorage.getItem(storageKeys.accessCode) || "";
let messages = loadMessages();

function nowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadMessages() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKeys.messages) || "[]");
    return Array.isArray(parsed) ? parsed.slice(-120) : [];
  } catch {
    return [];
  }
}

function saveMessages() {
  localStorage.setItem(storageKeys.messages, JSON.stringify(messages.slice(-120)));
}

function loadSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(storageKeys.settings) || "{}");
    for (const [key, value] of Object.entries(settings)) {
      if (els[key] && typeof value === "string") {
        els[key].value = value;
      }
    }
  } catch {
    // Ignore broken local settings.
  }

  const note = localStorage.getItem(storageKeys.note);
  if (note) {
    els.noteOutput.textContent = note;
    els.copyNoteBtn.disabled = false;
  }
}

function saveSettings() {
  const settings = {
    companionName: els.companionName.value,
    language: els.language.value,
    style: els.style.value,
    focus: els.focus.value
  };
  localStorage.setItem(storageKeys.settings, JSON.stringify(settings));
}

function setStatus(text, state = "idle") {
  els.status.textContent = text;
  els.status.classList.toggle("live", state === "live");
  els.status.classList.toggle("error", state === "error");
  els.meter.classList.toggle("live", state === "live");
}

function setServerStatus(text, state = "idle") {
  els.serverStatus.textContent = text;
  els.serverDot.classList.toggle("ready", state === "ready");
  els.serverDot.classList.toggle("error", state === "error");
}

function setKeyStatus(text, state = "idle") {
  els.keyStatus.textContent = text;
  els.keyStatus.classList.toggle("ready", state === "ready");
  els.keyStatus.classList.toggle("error", state === "error");
}

function setAccessStatus(text, state = "idle") {
  els.accessStatus.textContent = text;
  els.accessStatus.classList.toggle("ready", state === "ready");
  els.accessStatus.classList.toggle("error", state === "error");
}

function authHeaders(extra = {}) {
  return accessCode ? { ...extra, "X-Access-Code": accessCode } : extra;
}

function clearEmptyState() {
  const empty = els.transcript.querySelector(".empty-state");
  if (empty) {
    empty.remove();
  }
}

function speakerForRole(role) {
  return {
    user: "你",
    assistant: "搭子",
    system: "System",
    search: "已查证",
    note: "笔记"
  }[role] || "Message";
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function createBubble(message) {
  clearEmptyState();

  const bubble = document.createElement("article");
  bubble.className = `bubble ${message.role}`;
  bubble.dataset.id = message.id;

  const meta = document.createElement("div");
  meta.className = "speaker";
  meta.textContent = `${speakerForRole(message.role)} · ${formatTime(message.timestamp)}`;

  const content = document.createElement("div");
  content.className = "content";
  content.textContent = message.text || "";

  bubble.append(meta, content);

  if (message.sources?.length) {
    bubble.append(renderSources(message.sources));
  }

  els.transcript.append(bubble);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return { bubble, content };
}

function renderSources(sources) {
  const list = document.createElement("ul");
  list.className = "sources";

  for (const source of sources.slice(0, 6)) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = source.title || source.url;
    item.append(link);
    list.append(item);
  }

  return list;
}

function addMessage(role, text, options = {}) {
  const message = {
    id: options.id || nowId(),
    role,
    text: text || "",
    sources: options.sources || [],
    timestamp: options.timestamp || Date.now()
  };
  const bubbleRef = createBubble(message);

  if (options.persist !== false) {
    messages.push(message);
    saveMessages();
  }

  return { message, ...bubbleRef };
}

function updateBubbleText(ref, text) {
  ref.message.text = text;
  ref.content.textContent = text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function persistTransientMessage(ref) {
  if (!ref?.message?.text?.trim()) {
    return;
  }
  messages.push(ref.message);
  saveMessages();
}

function renderMessages() {
  els.transcript.innerHTML = "";

  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<strong>可以开始了。</strong><span>按下开始后直接说；文字记录会保存在这个浏览器。</span>";
    els.transcript.append(empty);
    return;
  }

  for (const message of messages) {
    createBubble(message);
  }
}

function transcriptForPrompt(limit = 24) {
  return messages
    .filter((message) => ["user", "assistant", "search", "note"].includes(message.role))
    .slice(-limit)
    .map((message) => `${speakerForRole(message.role)}: ${message.text}`)
    .join("\n");
}

function getLatestUserText() {
  return [...messages].reverse().find((message) => message.role === "user")?.text || "";
}

function looksLikeSearchIntent(text) {
  return /(查一下|搜一下|帮我查|最新|今天|现在|价格|政策|新闻|汇率|天气|是真的吗|fact check|search)/i.test(text);
}

async function loadHealth() {
  try {
    const response = await fetch("/health");
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    const health = await response.json();
    setServerStatus("Server ready", "ready");
    setKeyStatus(health.hasApiKey ? "API key ready" : "API key missing", health.hasApiKey ? "ready" : "error");
    els.proxyStatus.textContent = `Route: ${health.proxy || "direct"} · ${health.realtimeModel}`;
    els.accessPanel.hidden = !health.requiresAccessCode;
    if (health.requiresAccessCode) {
      els.accessCode.value = accessCode;
      setAccessStatus(accessCode ? "分享码已保存。" : "请输入分享码。");
    }
  } catch {
    setServerStatus("Server unavailable", "error");
    setKeyStatus("API key unknown", "error");
    els.proxyStatus.textContent = "Route unavailable";
  }
}

function saveAccessCode() {
  accessCode = els.accessCode.value.trim();
  if (accessCode) {
    localStorage.setItem(storageKeys.accessCode, accessCode);
    setAccessStatus("分享码已保存。", "ready");
  } else {
    localStorage.removeItem(storageKeys.accessCode);
    setAccessStatus("请输入分享码。", "error");
  }
}

function waitForIceGathering(peerConnection) {
  if (peerConnection.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2200);

    function checkState() {
      if (peerConnection.iceGatheringState === "complete") {
        clearTimeout(timeout);
        peerConnection.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    }

    peerConnection.addEventListener("icegatheringstatechange", checkState);
  });
}

function sendRealtimeEvent(event) {
  if (!dc || dc.readyState !== "open") {
    return false;
  }

  dc.send(JSON.stringify(event));
  return true;
}

function beginConversation() {
  const kickoff = [
    "先用中文简短打招呼。",
    "告诉我可以直接说脑子里正在转的事。",
    "如果问题需要最新事实，提醒我可以点“联网查证”。",
    "然后问我：现在最想理顺的是什么？"
  ].join(" ");

  sendRealtimeEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: kickoff }]
    }
  });

  sendRealtimeEvent({ type: "response.create" });
}

function handleRealtimeMessage(message) {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    return;
  }

  if (event.type === "error") {
    addMessage("system", event.error?.message || "Realtime API returned an error.");
    setStatus("Error", "error");
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
    addMessage("user", event.transcript);
    if (looksLikeSearchIntent(event.transcript)) {
      els.searchInput.value = event.transcript;
    }
    return;
  }

  if (
    event.type === "response.audio_transcript.delta" ||
    event.type === "response.output_audio_transcript.delta" ||
    event.type === "response.text.delta"
  ) {
    if (!currentAssistant) {
      currentAssistant = addMessage("assistant", "", { persist: false });
    }
    updateBubbleText(currentAssistant, `${currentAssistant.message.text}${event.delta || ""}`);
    return;
  }

  if (
    event.type === "response.audio_transcript.done" ||
    event.type === "response.output_audio_transcript.done" ||
    event.type === "response.text.done" ||
    event.type === "response.done"
  ) {
    persistTransientMessage(currentAssistant);
    currentAssistant = undefined;
  }
}

function getSessionPayload(sdp) {
  saveSettings();
  return {
    sdp,
    companionName: els.companionName.value,
    language: els.language.value,
    style: els.style.value,
    focus: els.focus.value,
    recentContext: transcriptForPrompt(18)
  };
}

async function startSession() {
  els.startBtn.disabled = true;
  setStatus("Connecting");

  try {
    remoteAudio = new Audio();
    remoteAudio.autoplay = true;

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    pc = new RTCPeerConnection();

    pc.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      remoteAudio.play().catch(() => {
        addMessage("system", "如果没有声音，点一下页面后再继续。");
      });
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        setStatus(pc.connectionState === "closed" ? "Stopped" : "Disconnected", "error");
      }
    };

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    dc = pc.createDataChannel("oai-events");
    dc.addEventListener("open", () => {
      setStatus("Live", "live");
      els.muteBtn.disabled = false;
      els.stopBtn.disabled = false;
      els.sendMessageBtn.disabled = false;
      addMessage("system", "已连接。");
      beginConversation();
    });
    dc.addEventListener("message", handleRealtimeMessage);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const response = await fetch("/session", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(getSessionPayload(pc.localDescription.sdp))
    });

    const answerSdp = await response.text();
    if (!response.ok) {
      if (response.status === 401) {
        els.accessPanel.hidden = false;
        throw new Error("需要分享码。请输入后再开始。");
      }
      throw new Error(answerSdp || response.statusText);
    }

    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  } catch (error) {
    addMessage("system", error.message);
    setStatus("Error", "error");
    stopSession();
  }
}

function stopSession() {
  if (dc) {
    dc.close();
    dc = undefined;
  }

  if (pc) {
    pc.close();
    pc = undefined;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = undefined;
  }

  remoteAudio = undefined;
  currentAssistant = undefined;
  isMuted = false;
  els.muteBtn.querySelector("span:last-child").textContent = "静音";
  els.startBtn.disabled = false;
  els.muteBtn.disabled = true;
  els.stopBtn.disabled = true;
  els.sendMessageBtn.disabled = true;

  if (els.status.textContent !== "Error") {
    setStatus("Stopped");
  }
}

function toggleMute() {
  if (!localStream) {
    return;
  }

  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMuted;
  });
  els.muteBtn.querySelector("span:last-child").textContent = isMuted ? "取消静音" : "静音";
}

function sendTextMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  addMessage("user", trimmed);
  const sent = sendRealtimeEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: trimmed }]
    }
  });

  if (sent) {
    sendRealtimeEvent({ type: "response.create" });
  } else {
    addMessage("system", "当前还没有语音连接。先点“开始说话”，或者用“联网查证 / 生成笔记”。");
  }
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body)
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : { error: await response.text() };

  if (!response.ok) {
    if (response.status === 401) {
      els.accessPanel.hidden = false;
      throw new Error("需要分享码。请输入后再试。");
    }
    throw new Error(payload.error || response.statusText);
  }

  return payload;
}

async function runSearch(event) {
  event?.preventDefault();
  const query = (els.searchInput.value || getLatestUserText()).trim();
  if (!query) {
    addMessage("system", "还没有可查的问题。");
    return;
  }

  els.searchBtn.disabled = true;
  const pending = addMessage("search", `正在查证：${query}`, { persist: false });

  try {
    const result = await postJson("/search", {
      query,
      context: transcriptForPrompt(18)
    });

    pending.message.sources = result.sources || [];
    pending.bubble.append(renderSources(pending.message.sources));
    updateBubbleText(pending, result.text);
    persistTransientMessage(pending);

    if (sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "我刚刚做了一次联网查证。请用口语简短回应，不要假装自己亲自浏览网页。",
              `问题：${query}`,
              `查证结果：${result.text}`,
              result.sources?.length ? `来源：${result.sources.map((source) => source.title || source.url).join("；")}` : "来源：没有返回可展示来源"
            ].join("\n")
          }
        ]
      }
    })) {
      sendRealtimeEvent({ type: "response.create" });
    }
  } catch (error) {
    updateBubbleText(pending, error.message);
    pending.message.role = "system";
    pending.bubble.className = "bubble system";
    persistTransientMessage(pending);
  } finally {
    els.searchBtn.disabled = false;
  }
}

async function summarize() {
  const transcript = transcriptForPrompt(60);
  if (!transcript) {
    addMessage("system", "还没有可以总结的对话。");
    return;
  }

  els.summarizeBtn.disabled = true;
  els.noteOutput.textContent = "正在整理...";

  try {
    const result = await postJson("/summarize", { transcript });
    els.noteOutput.textContent = result.text;
    localStorage.setItem(storageKeys.note, result.text);
    els.copyNoteBtn.disabled = false;
    addMessage("note", result.text);
  } catch (error) {
    els.noteOutput.textContent = error.message;
  } finally {
    els.summarizeBtn.disabled = false;
  }
}

async function copyNote() {
  const text = els.noteOutput.textContent.trim();
  if (!text || text === "还没有笔记。") {
    return;
  }

  await navigator.clipboard.writeText(text);
  els.copyNoteBtn.querySelector("span:last-child").textContent = "已复制";
  setTimeout(() => {
    els.copyNoteBtn.querySelector("span:last-child").textContent = "复制";
  }, 1200);
}

function clearHistory() {
  if (!messages.length || window.confirm("清空这个浏览器里的对话记录？")) {
    messages = [];
    saveMessages();
    localStorage.removeItem(storageKeys.note);
    els.noteOutput.textContent = "还没有笔记。";
    els.copyNoteBtn.disabled = true;
    renderMessages();
  }
}

els.startBtn.addEventListener("click", startSession);
els.stopBtn.addEventListener("click", stopSession);
els.muteBtn.addEventListener("click", toggleMute);
els.clearHistoryBtn.addEventListener("click", clearHistory);
els.saveAccessBtn.addEventListener("click", saveAccessCode);
els.accessPanel.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAccessCode();
});
els.accessCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveAccessCode();
  }
});
els.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendTextMessage(els.messageInput.value);
  els.messageInput.value = "";
});
els.searchForm.addEventListener("submit", runSearch);
els.summarizeBtn.addEventListener("click", summarize);
els.copyNoteBtn.addEventListener("click", copyNote);

for (const input of [els.companionName, els.language, els.style, els.focus]) {
  input.addEventListener("change", saveSettings);
}

loadSettings();
renderMessages();
loadHealth();
