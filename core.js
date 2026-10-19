/* Shared timing and validation. No browser or network dependencies. */
(function (root) {
  "use strict";

  function validateSettings(values) {
    const inhale = Number(values.inhale);
    const exhale = Number(values.exhale);
    const minutes = Number(values.minutes);
    const seconds = Number(values.seconds);
    if ([values.inhale, values.exhale, values.minutes, values.seconds].some(value => String(value).trim() === "")) {
      throw new Error("请填写完整的吸气、呼气和总时长.");
    }
    for (const [name, value] of [["吸气", inhale], ["呼气", exhale]]) {
      if (!Number.isFinite(value) || value < 1 || value > 60 || !Number.isInteger(value * 2)) {
        throw new Error(name + "时长请设为 1 至 60 秒, 以 0.5 秒为单位.");
      }
    }
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 180 || !Number.isInteger(seconds) || seconds < 0 || seconds > 59) {
      throw new Error("总时长的分钟数请填 0 至 180, 秒数请填 0 至 59, 均为整数.");
    }
    const total = minutes * 60 + seconds;
    if (total < 1) throw new Error("练习总时长至少为 1 秒.");
    return Object.freeze({ inhale, exhale, minutes, seconds, total, cycle: inhale + exhale });
  }

  function frameAt(settings, elapsedSeconds) {
    const elapsed = Math.max(0, Math.min(settings.total, elapsedSeconds));
    const complete = elapsed >= settings.total;
    const cycleIndex = Math.floor((elapsed + 1e-9) / settings.cycle);
    const position = elapsed - cycleIndex * settings.cycle;
    const inhale = position < settings.inhale - 1e-9;
    const phase = inhale ? "inhale" : "exhale";
    const phaseDuration = inhale ? settings.inhale : settings.exhale;
    const phaseElapsed = Math.max(0, position - (inhale ? 0 : settings.inhale));
    return {
      elapsed,
      complete,
      remaining: Math.max(0, settings.total - elapsed),
      progress: elapsed / settings.total,
      completedCycles: cycleIndex,
      phase,
      phaseProgress: Math.min(1, phaseElapsed / phaseDuration),
      phaseRemaining: Math.max(0, phaseDuration - phaseElapsed)
    };
  }

  function formatTime(seconds) {
    const whole = Math.max(0, Math.ceil(seconds - 1e-9));
    return String(Math.floor(whole / 60)).padStart(2, "0") + ":" + String(whole % 60).padStart(2, "0");
  }

  const api = Object.freeze({ validateSettings, frameAt, formatTime });
  root.BreathingCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis === "undefined" ? window : globalThis);
