(function () {
  "use strict";

  const { validateSettings, frameAt, formatTime } = window.BreathingCore;
  const byId = id => document.getElementById(id);
  const ui = {
    inhale: byId("inhale-seconds"), exhale: byId("exhale-seconds"),
    minutes: byId("total-minutes"), seconds: byId("total-seconds"),
    volume: byId("volume"), volumeValue: byId("volume-value"),
    start: byId("start-button"), startLabel: byId("start-label"), reset: byId("reset-button"),
    fields: byId("timing-fields"), state: byId("session-state"), summary: byId("cycle-summary"),
    stage: byId("breathing-stage"), orb: byId("breathing-orb"), ring: byId("phase-ring"),
    caption: byId("phase-caption"), phase: byId("phase-name"), count: byId("phase-count"),
    instruction: byId("practice-instruction"), remaining: byId("remaining-time"),
    cycles: byId("completed-cycles"), total: byId("total-time"),
    progress: byId("session-progress"), fill: byId("session-progress-fill"),
    feedback: byId("feedback"), previewInhale: byId("preview-inhale"), previewExhale: byId("preview-exhale")
  };
  const presets = [...document.querySelectorAll(".preset")];
  const storageKey = "yangshengzhu-breath-settings-v1";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const sampleRate = 22050;
  const cueDuration = 2.4;
  let status = "idle";
  let settings = null;
  let audio = null;
  let masterGain = null;
  let cycleBuffer = null;
  let source = null;
  let finishSource = null;
  let previews = new Set();
  let elapsedBeforeStart = 0;
  let audioStartedAt = 0;
  let animationId = 0;
  let wakeLock = null;
  let wakePending = false;
  let startPending = false;

  function showFeedback(message, error = false) {
    ui.feedback.textContent = message;
    ui.feedback.classList.toggle("is-error", error);
  }

  function readSettings() {
    return validateSettings({ inhale: ui.inhale.value, exhale: ui.exhale.value, minutes: ui.minutes.value, seconds: ui.seconds.value });
  }

  function saveSettings() {
    try {
      const valid = readSettings();
      localStorage.setItem(storageKey, JSON.stringify({ ...valid, volume: Number(ui.volume.value) }));
    } catch (_) { /* Storage can be disabled for local files. The timer still works. */ }
  }

  function restoreSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved) return;
      const valid = validateSettings(saved);
      ui.inhale.value = valid.inhale;
      ui.exhale.value = valid.exhale;
      ui.minutes.value = valid.minutes;
      ui.seconds.value = valid.seconds;
      if (Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 100) ui.volume.value = saved.volume;
    } catch (_) { /* Fall back to the visible defaults. */ }
  }

  function updatePresetButtons() {
    for (const preset of presets) {
      const selected = Number(preset.dataset.inhale) === Number(ui.inhale.value) && Number(preset.dataset.exhale) === Number(ui.exhale.value);
      preset.classList.toggle("is-selected", selected);
      preset.setAttribute("aria-pressed", String(selected));
    }
  }

  function updateIdleSettings() {
    updatePresetButtons();
    try {
      const next = readSettings();
      ui.summary.textContent = next.inhale + " 秒吸气 / " + next.exhale + " 秒呼气";
      if (status === "idle" || status === "complete") {
        if (status === "complete") resetSession();
        ui.remaining.textContent = formatTime(next.total);
        ui.total.textContent = formatTime(next.total);
      }
      showFeedback("");
      return true;
    } catch (error) {
      showFeedback(error.message, true);
      return false;
    }
  }

  function updateVolume() {
    const value = Number(ui.volume.value);
    ui.volumeValue.value = value + "%";
    if (masterGain && audio) masterGain.gain.setTargetAtTime(value / 100, audio.currentTime, 0.025);
  }

  async function ensureAudio() {
    if (!audio) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error("当前浏览器不支持提示音, 请使用较新的 Safari、Chrome 或 Edge.");
      audio = new AudioContext();
      masterGain = audio.createGain();
      masterGain.gain.value = Number(ui.volume.value) / 100;
      masterGain.connect(audio.destination);
      audio.addEventListener("statechange", () => {
        if ((audio.state === "suspended" || audio.state === "interrupted" || audio.state === "closed") && status === "running") {
          pauseSession("声音播放被系统中断, 已暂停. 回到页面后点击继续.");
        }
      });
    }
    if (audio.state !== "running") await audio.resume();
    if (audio.state !== "running") throw new Error("提示音尚未启用, 请再次点击开始, 并检查浏览器声音权限.");
  }

  // Short notes for the completion chime.
  function addNote(data, offsetSeconds, frequency, strength = 0.3) {
    const offset = Math.round(offsetSeconds * sampleRate);
    const length = Math.round(0.4 * sampleRate);
    for (let i = 0; i < length && offset + i < data.length; i += 1) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / 0.008);
      const release = Math.min(1, (length - i) / (sampleRate * 0.04));
      const envelope = attack * Math.exp(-10 * t) * release;
      const fundamental = Math.sin(2 * Math.PI * frequency * t);
      const overtone = 0.16 * Math.sin(2 * Math.PI * frequency * 2 * t);
      data[offset + i] += strength * envelope * (fundamental + overtone);
    }
  }

  function addCue(data, offsetSeconds, phase, duration = cueDuration) {
    // One bright bell strike with a sustained fundamental and faster-decaying
    // metallic partials. The two pitches distinguish inhale from exhale.
    const frequency = phase === "inhale" ? 880 : 659.255;
    const offset = Math.round(offsetSeconds * sampleRate);
    const length = Math.round(duration * sampleRate);
    for (let i = 0; i < length && offset + i < data.length; i += 1) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / 0.003);
      const release = Math.min(1, (length - 1 - i) / (sampleRate * 0.12));
      const body = Math.sin(2 * Math.PI * frequency * t) * Math.exp(-3 * t);
      const shimmer = 0.27 * Math.sin(2 * Math.PI * frequency * 2.756 * t) * Math.exp(-7 * t)
        + 0.08 * Math.sin(2 * Math.PI * frequency * 5.404 * t) * Math.exp(-13 * t);
      data[offset + i] += 0.38 * attack * release * (body + shimmer);
    }
  }

  function makeCueBuffer(phase, duration = cueDuration) {
    const buffer = audio.createBuffer(1, Math.round(sampleRate * duration), sampleRate);
    addCue(buffer.getChannelData(0), 0, phase, duration);
    return buffer;
  }

  function makeCycleBuffer() {
    const buffer = audio.createBuffer(1, Math.round(sampleRate * settings.cycle), sampleRate);
    const data = buffer.getChannelData(0);
    addCue(data, 0, "inhale", Math.min(cueDuration, settings.inhale));
    addCue(data, settings.inhale, "exhale", Math.min(cueDuration, settings.exhale));
    return buffer;
  }

  function makeFinishBuffer() {
    const buffer = audio.createBuffer(1, sampleRate, sampleRate);
    const data = buffer.getChannelData(0);
    addNote(data, 0, 392, 0.19);
    addNote(data, 0.18, 523.251, 0.17);
    addNote(data, 0.36, 659.255, 0.14);
    return buffer;
  }

  function disposeNode(node) {
    if (!node) return;
    node.onended = null;
    try { node.stop(); } catch (_) { /* May already have ended. */ }
    node.disconnect();
  }

  function stopPreviews() {
    for (const node of previews) disposeNode(node);
    previews.clear();
  }

  function stopSessionAudio() {
    disposeNode(source);
    disposeNode(finishSource);
    source = null;
    finishSource = null;
    cancelAnimationFrame(animationId);
  }

  function currentElapsed() {
    if (status !== "running") return elapsedBeforeStart;
    return Math.min(settings.total, elapsedBeforeStart + Math.max(0, audio.currentTime - audioStartedAt));
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || document.hidden || wakeLock || wakePending || status !== "running") return;
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (status !== "running" || document.hidden) {
        await lock.release();
      } else {
        wakeLock = lock;
        lock.addEventListener("release", () => { if (wakeLock === lock) wakeLock = null; });
      }
    } catch (_) { /* Optional feature. The user can keep the device awake manually. */ }
    finally { wakePending = false; }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    const lock = wakeLock;
    wakeLock = null;
    lock.release().catch(() => {});
  }

  function setControls() {
    ui.fields.disabled = status === "running" || status === "paused" || startPending;
    ui.previewInhale.disabled = status === "running" || startPending;
    ui.previewExhale.disabled = status === "running" || startPending;
    ui.reset.disabled = status === "idle" || startPending;
    ui.start.disabled = startPending;
    ui.startLabel.textContent = status === "running" ? "暂停练习" : status === "paused" ? "继续练习" : status === "complete" ? "再练一次" : "开始练习";
    ui.start.querySelector("svg").innerHTML = status === "running" ? '<path d="M8 5h3v14H8Zm7 0h3v14h-3Z"/>' : '<path d="m9 5 11 7-11 7Z"/>';
    ui.state.textContent = status === "running" ? "正在练习" : status === "paused" ? "已暂停" : status === "complete" ? "本次已完成" : "准备开始";
  }

  function renderFrame() {
    if (!settings) return;
    cancelAnimationFrame(animationId);
    const frame = frameAt(settings, currentElapsed());
    ui.remaining.textContent = formatTime(frame.remaining);
    ui.total.textContent = formatTime(settings.total);
    ui.cycles.textContent = frame.completedCycles;
    ui.fill.style.width = (frame.progress * 100) + "%";
    ui.progress.setAttribute("aria-valuenow", String(Math.round(frame.progress * 100)));

    if (status === "complete") {
      ui.stage.dataset.phase = "ready";
      ui.caption.textContent = "把从容带回日常";
      ui.phase.textContent = "完成";
      ui.count.textContent = "好好呼吸, 也好好休息";
      ui.instruction.textContent = "本次练习已结束, 回到自然呼吸.";
      ui.orb.style.transform = "scale(.78)";
      ui.ring.style.strokeDashoffset = "0";
      return;
    }

    const inhale = frame.phase === "inhale";
    const label = inhale ? "吸气" : "呼气";
    const eased = (1 - Math.cos(Math.PI * frame.phaseProgress)) / 2;
    const scale = reducedMotion.matches ? 0.84 : (inhale ? 0.66 + eased * 0.34 : 1 - eased * 0.34);
    ui.orb.style.transform = "scale(" + scale + ")";
    ui.ring.style.strokeDashoffset = String(100 * (1 - frame.phaseProgress));
    ui.stage.dataset.phase = status === "paused" ? "paused" : frame.phase;
    ui.caption.textContent = status === "paused" ? "休息一下, 无需屏息" : inhale ? "轻轻吸入, 不必吸满" : "慢慢呼出, 不必呼尽";
    const phaseText = status === "paused" ? "暂停" : label;
    if (ui.phase.textContent !== phaseText) ui.phase.textContent = phaseText;
    ui.count.textContent = (status === "paused" ? label + "剩余 " : "剩余 ") + frame.phaseRemaining.toFixed(1) + " 秒";
    ui.instruction.textContent = status === "paused" ? "点击继续后, 从当前阶段的剩余时间接着练习." : "吸气听高音钟声, 呼气听低音钟声.";
    if (status === "running") animationId = requestAnimationFrame(renderFrame);
  }

  function completeSession() {
    if (status !== "running") return;
    status = "complete";
    elapsedBeforeStart = settings.total;
    cancelAnimationFrame(animationId);
    if (source) { source.onended = null; source.disconnect(); source = null; }
    releaseWakeLock();
    setControls();
    renderFrame();
    showFeedback("练习已完成. 你可以调整时间, 或再练一次.");
  }

  async function startOrResume() {
    if (startPending) return;
    const resuming = status === "paused";
    if (!resuming) {
      try { settings = readSettings(); }
      catch (error) { showFeedback(error.message, true); return; }
    }
    startPending = true;
    setControls();
    try {
      await ensureAudio();
      stopSessionAudio();
      stopPreviews();
      if (!resuming) {
        elapsedBeforeStart = 0;
        cycleBuffer = makeCycleBuffer();
      }
      saveSettings();
      const remaining = settings.total - elapsedBeforeStart;
      if (remaining <= 0) { status = "running"; completeSession(); return; }

      // The loop contains both phase cues. The audio engine, not page timers,
      // repeats it and stops it at the exact remaining session duration.
      audioStartedAt = audio.currentTime + 0.035;
      source = audio.createBufferSource();
      source.buffer = cycleBuffer;
      source.loop = true;
      source.connect(masterGain);
      const activeSource = source;
      source.onended = () => { if (source === activeSource && status === "running") completeSession(); };
      const offset = elapsedBeforeStart % settings.cycle;
      source.start(audioStartedAt, offset);
      source.stop(audioStartedAt + remaining);

      finishSource = audio.createBufferSource();
      finishSource.buffer = makeFinishBuffer();
      finishSource.connect(masterGain);
      const ending = finishSource;
      ending.onended = () => { ending.disconnect(); if (finishSource === ending) finishSource = null; };
      ending.start(audioStartedAt + remaining);

      // On resume, replay the current cue only when its original chime has
      // already passed. The loop already supplies a cue near phase boundaries.
      const frame = frameAt(settings, elapsedBeforeStart);
      const phaseElapsed = (frame.phase === "inhale" ? settings.inhale : settings.exhale) - frame.phaseRemaining;
      if (resuming && phaseElapsed >= cueDuration && remaining > 0.65) {
        const cue = audio.createBufferSource();
        cue.buffer = makeCueBuffer(frame.phase, Math.min(cueDuration, frame.phaseRemaining, remaining));
        cue.connect(masterGain);
        previews.add(cue);
        cue.onended = () => { cue.disconnect(); previews.delete(cue); };
        cue.start(audioStartedAt);
      }
      status = "running";
      showFeedback(Number(ui.volume.value) === 0 ? "当前为静音, 可以随时调高音量." : "");
      renderFrame();
      requestWakeLock();
    } catch (error) {
      stopSessionAudio();
      stopPreviews();
      releaseWakeLock();
      status = resuming ? "paused" : "idle";
      showFeedback(error.message || "无法启动提示音, 请刷新页面后重试.", true);
    } finally {
      startPending = false;
      setControls();
    }
  }

  function pauseSession(message = "已暂停. 可以自然呼吸, 无需保持当前吸气或呼气.") {
    if (status !== "running") return;
    elapsedBeforeStart = currentElapsed();
    if (elapsedBeforeStart >= settings.total) { completeSession(); return; }
    status = "paused";
    stopSessionAudio();
    stopPreviews();
    releaseWakeLock();
    setControls();
    renderFrame();
    showFeedback(message);
  }

  function resetSession() {
    status = "idle";
    stopSessionAudio();
    stopPreviews();
    releaseWakeLock();
    elapsedBeforeStart = 0;
    settings = null;
    cycleBuffer = null;
    ui.stage.dataset.phase = "ready";
    ui.orb.style.transform = "scale(.78)";
    ui.ring.style.strokeDashoffset = "100";
    ui.caption.textContent = "让呼吸自然发生";
    ui.phase.textContent = "就绪";
    ui.count.textContent = "随时开始";
    ui.instruction.textContent = "吸气时圆环舒展, 呼气时缓缓收拢.";
    ui.cycles.textContent = "0";
    ui.fill.style.width = "0%";
    ui.progress.setAttribute("aria-valuenow", "0");
    showFeedback("");
    setControls();
    updateIdleSettings();
  }

  async function preview(phase) {
    if (status === "running" || startPending) return;
    try {
      await ensureAudio();
      if (status === "running" || startPending) return;
      stopPreviews();
      const node = audio.createBufferSource();
      node.buffer = makeCueBuffer(phase);
      node.connect(masterGain);
      previews.add(node);
      node.onended = () => { node.disconnect(); previews.delete(node); };
      node.start();
      showFeedback(Number(ui.volume.value) === 0 ? "当前音量为 0, 调高后即可试听." : phase === "inhale" ? "吸气提示: 清脆的高音钟声." : "呼气提示: 柔和的低音钟声.");
    } catch (error) { showFeedback(error.message, true); }
  }

  byId("settings-form").addEventListener("submit", event => event.preventDefault());
  ui.start.addEventListener("click", () => { if (status === "running") pauseSession(); else startOrResume(); });
  ui.reset.addEventListener("click", resetSession);
  ui.previewInhale.addEventListener("click", () => preview("inhale"));
  ui.previewExhale.addEventListener("click", () => preview("exhale"));
  ui.volume.addEventListener("input", () => { updateVolume(); saveSettings(); });
  for (const input of [ui.inhale, ui.exhale, ui.minutes, ui.seconds]) {
    input.addEventListener("input", updateIdleSettings);
    input.addEventListener("change", saveSettings);
  }
  for (const preset of presets) {
    preset.addEventListener("click", () => {
      ui.inhale.value = preset.dataset.inhale;
      ui.exhale.value = preset.dataset.exhale;
      updateIdleSettings();
      saveSettings();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && status === "running") {
      renderFrame();
      requestWakeLock();
    }
  });
  window.addEventListener("pagehide", () => {
    if (status === "running") pauseSession();
    stopPreviews();
  });
  restoreSettings();
  updateVolume();
  updateIdleSettings();
  setControls();
})();
