/**
 * pyMorseRunner — WebAudio Streamer, N1MM Keyboard Controller & Visualizers
 */

"use strict";

(() => {
  const contest = new ContestEngine.Contest();

  // DOM References
  const runModeSelect = document.getElementById("runModeSelect");
  const runToggleBtn = document.getElementById("runToggleBtn");
  const exportCabrilloBtn = document.getElementById("exportCabrilloBtn");
  const exportAdifBtn = document.getElementById("exportAdifBtn");
  const downloadWavBtn = document.getElementById("downloadWavBtn");
  const userInfoChip = document.getElementById("userInfoChip");
  const adminPortalLink = document.getElementById("adminPortalLink");
  const signOutLink = document.getElementById("signOutLink");

  let csrfToken = "";

  // Strict ASCII-printable taint-checking helper (0x20..0x7E + field whitelist + length cap)
  function taintClean(raw, allowRegex, maxLen) {
    const str = String(raw || "");
    let ascii = "";
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= 0x20 && code <= 0x7e) {
        ascii += str[i];
      }
    }
    return ascii.toUpperCase().replace(allowRegex, "").slice(0, maxLen);
  }

  const activeModeLabel = document.getElementById("activeModeLabel");
  const clockAndRateLabel = document.getElementById("clockAndRateLabel");
  const thRecv = document.getElementById("thRecv");
  const thSent = document.getElementById("thSent");
  const logContainer = document.getElementById("logContainer");
  const logTableBody = document.getElementById("logTableBody");

  const callInput = document.getElementById("callInput");
  const exch1Input = document.getElementById("exch1Input");
  const exch2Input = document.getElementById("exch2Input");
  const labelExch1 = document.getElementById("labelExch1");
  const labelExch2 = document.getElementById("labelExch2");
  const f2KeyText = document.getElementById("f2KeyText");
  const wipeBtn = document.getElementById("wipeBtn");

  const txLed = document.getElementById("txLed");
  const trxStateText = document.getElementById("trxStateText");
  const ritValueText = document.getElementById("ritValueText");
  const ritDownBtn = document.getElementById("ritDownBtn");
  const ritResetBtn = document.getElementById("ritResetBtn");
  const ritUpBtn = document.getElementById("ritUpBtn");
  const bwStatusText = document.getElementById("bwStatusText");
  const smeterCanvas = document.getElementById("smeterCanvas");
  const smeterText = document.getElementById("smeterText");

  const passbandCanvas = document.getElementById("passbandCanvas");
  const histoCanvas = document.getElementById("histoCanvas");

  const myCallInput = document.getElementById("myCallInput");
  const myNameInput = document.getElementById("myNameInput");
  const mySpcInput = document.getElementById("mySpcInput");
  const myCwtInput = document.getElementById("myCwtInput");
  const wpmInput = document.getElementById("wpmInput");
  const wpmQuickBadge = document.getElementById("wpmQuickBadge");
  const pitchSelect = document.getElementById("pitchSelect");
  const bwSelect = document.getElementById("bwSelect");
  const monGainInput = document.getElementById("monGainInput");
  const monGainValText = document.getElementById("monGainValText");
  const qskCheck = document.getElementById("qskCheck");
  const recWavCheck = document.getElementById("recWavCheck");

  const activityInput = document.getElementById("activityInput");
  const durationInput = document.getElementById("durationInput");
  const qrnModelSelect = document.getElementById("qrnModelSelect");
  const qrnCheck = document.getElementById("qrnCheck");
  const qrmCheck = document.getElementById("qrmCheck");
  const qsbCheck = document.getElementById("qsbCheck");
  const flutterCheck = document.getElementById("flutterCheck");
  const lidsCheck = document.getElementById("lidsCheck");
  const sigSpreadCheck = document.getElementById("sigSpreadCheck");

  const rawPtsCell = document.getElementById("rawPtsCell");
  const valPtsCell = document.getElementById("valPtsCell");
  const rawMulCell = document.getElementById("rawMulCell");
  const valMulCell = document.getElementById("valMulCell");
  const rawScoreCell = document.getElementById("rawScoreCell");
  const valScoreCell = document.getElementById("valScoreCell");
  const crcBadgeText = document.getElementById("crcBadgeText");

  let audioCtx = null;
  let scriptNode = null;
  let mustAdvance = false;
  let recordedBlocks = [];
  const MAX_RECORDED_BLOCKS = 155040; // Max ~120 minutes at 11025 Hz / 512 samples
  let lastAudioBlock = new Float32Array(DSP.DEFAULTBUFSIZE);

  // ---------------------------------------------------------------------------
  // Mode UI Adaptation (K1USN SST vs CWT vs WPX/Pileup/HST)
  // ---------------------------------------------------------------------------
  const MODE_TITLES = {
    rmSst: "K1USN Slow Speed Test (SST — Max 20 WPM)",
    rmCwt: "CWops CWT (Name + Member# / SPC)",
    rmPileup: "Pile-Up (CQ WPX — RST + Serial#)",
    rmSingle: "Single Calls (RST + Serial#)",
    rmWpx: "WPX Competition (Locked Conditions)",
    rmHst: "IARU HST Competition",
  };

  function isNameExchMode(mode = contest.ini.runMode || runModeSelect.value) {
    return mode === "rmSst" || mode === "rmCwt";
  }

  function syncModeLabels() {
    const mode = runModeSelect.value;
    activeModeLabel.textContent = `Mode: ${MODE_TITLES[mode] || mode}`;
    if (mode === "rmSst") {
      labelExch1.textContent = "Name";
      exch1Input.placeholder = "NAME";
      labelExch2.textContent = "State / Prov / DX";
      exch2Input.placeholder = "S/P/DX";
      thRecv.textContent = "Recv (Name / SPC)";
      thSent.textContent = "Sent (Name / SPC)";
      f2KeyText.textContent = "<Name SPC>";
      if (Number(wpmInput.value) > 20) {
        wpmInput.value = "20";
        contest.setWpm(20);
        wpmQuickBadge.textContent = "20 WPM";
      }
    } else if (mode === "rmCwt") {
      labelExch1.textContent = "Name";
      exch1Input.placeholder = "NAME";
      labelExch2.textContent = "Nr / SPC";
      exch2Input.placeholder = "NR/SPC";
      thRecv.textContent = "Recv (Name / Nr)";
      thSent.textContent = "Sent (Name / Nr)";
      f2KeyText.textContent = "<Name Nr>";
    } else {
      labelExch1.textContent = "RST";
      exch1Input.placeholder = "599";
      labelExch2.textContent = "Serial #";
      exch2Input.placeholder = "001";
      thRecv.textContent = "Recv (RST / #)";
      thSent.textContent = "Sent (RST / #)";
      f2KeyText.textContent = "<#>";
    }
  }

  // ---------------------------------------------------------------------------
  // Web Audio API Real-Time Streaming (11,025 Hz DSP Engine -> AudioContext)
  // ---------------------------------------------------------------------------
  let resampleRing = new Float32Array(0);
  let resamplePos = 0.0;

  function startAudioEngine() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      try {
        audioCtx = new AudioContextClass({ sampleRate: DSP.DEFAULTRATE });
      } catch (_e) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }

    if (scriptNode) {
      scriptNode.disconnect();
      scriptNode = null;
    }

    const hwRate = audioCtx.sampleRate;
    const ratio = DSP.DEFAULTRATE / hwRate;
    const bufferLen = hwRate <= 16000 ? 512 : 2048;

    scriptNode = audioCtx.createScriptProcessor(bufferLen, 0, 1);
    resampleRing = new Float32Array(0);
    resamplePos = 0.0;

    scriptNode.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0);
      if (contest.ini.runMode === "rmStop") {
        out.fill(0);
        return;
      }

      if (Math.abs(hwRate - DSP.DEFAULTRATE) < 1) {
        const block = contest.getAudio();
        lastAudioBlock = block;
        if (recWavCheck.checked && recordedBlocks.length < MAX_RECORDED_BLOCKS) {
          recordedBlocks.push(new Float32Array(block));
          if (downloadWavBtn.disabled) downloadWavBtn.disabled = false;
        }
        for (let i = 0; i < out.length; i++) {
          out[i] = Math.max(-1.0, Math.min(1.0, (block[i] || 0) / 32768.0));
        }
        return;
      }

      // Linear resampling from 11,025 Hz engine to hardware sample rate
      for (let i = 0; i < out.length; i++) {
        while (resamplePos + 1 >= resampleRing.length) {
          const nextBlk = contest.getAudio();
          lastAudioBlock = nextBlk;
          if (recWavCheck.checked && recordedBlocks.length < MAX_RECORDED_BLOCKS) {
            recordedBlocks.push(new Float32Array(nextBlk));
            if (downloadWavBtn.disabled) downloadWavBtn.disabled = false;
          }
          const remStart = Math.floor(resamplePos);
          const rem = resampleRing.subarray(remStart);
          const merged = new Float32Array(rem.length + nextBlk.length);
          merged.set(rem, 0);
          merged.set(nextBlk, rem.length);
          resampleRing = merged;
          resamplePos -= remStart;
        }
        const idx = Math.floor(resamplePos);
        const frac = resamplePos - idx;
        const s0 = resampleRing[idx];
        const s1 = resampleRing[idx + 1];
        const sample = s0 + frac * (s1 - s0);
        out[i] = Math.max(-1.0, Math.min(1.0, sample / 32768.0));
        resamplePos += ratio;
      }
    };

    scriptNode.connect(audioCtx.destination);
  }

  function stopAudioEngine() {
    if (scriptNode) {
      scriptNode.disconnect();
      scriptNode = null;
    }
    if (audioCtx && audioCtx.state === "running") {
      audioCtx.suspend().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Start / Stop Contest Session
  // ---------------------------------------------------------------------------
  function syncSettingsFromInputs() {
    const prevFlags = {
      qrn: contest.ini.qrn,
      qrm: contest.ini.qrm,
      qsb: contest.ini.qsb,
      flutter: contest.ini.flutter,
      lids: contest.ini.lids,
    };
    myCallInput.value = taintClean(myCallInput.value, /[^A-Z0-9/]/g, 15) || "N9FZ";
    myNameInput.value = taintClean(myNameInput.value, /[^A-Z]/g, 12) || "BOB";
    mySpcInput.value = taintClean(mySpcInput.value, /[^A-Z0-9]/g, 6) || "IN";
    myCwtInput.value = taintClean(myCwtInput.value, /[^A-Z0-9]/g, 8) || "2104";

    contest.ini.call = myCallInput.value;
    contest.ini.hamName = myNameInput.value;
    contest.ini.mySpc = mySpcInput.value;
    contest.ini.myCwt = myCwtInput.value;
    let targetWpm = Number(wpmInput.value) || 20;
    if (runModeSelect.value === "rmSst" && targetWpm > 20) {
      targetWpm = 20;
      wpmInput.value = "20";
      wpmQuickBadge.textContent = "20 WPM";
    }
    contest.setWpm(targetWpm);
    contest.setPitch(Number(pitchSelect.value) || 600);
    contest.setBandwidth(Number(bwSelect.value) || 500);
    const monDb = Number(monGainInput.value);
    contest.ini.monVolumeDb = Number.isFinite(monDb) ? monDb : -6;
    contest.ini.qsk = qskCheck.checked;
    contest.ini.activity = Math.max(1, Math.min(9, Number(activityInput.value) || 3));
    const clampedDur = Math.max(1, Math.min(60, Number(durationInput.value) || 30));
    durationInput.value = String(clampedDur);
    contest.ini.duration = clampedDur;
    contest.ini.qrnModel = qrnModelSelect.value;
    contest.ini.qrn = qrnCheck.checked;
    contest.ini.qrm = qrmCheck.checked;
    contest.ini.qsb = qsbCheck.checked;
    contest.ini.flutter = flutterCheck.checked;
    contest.ini.lids = lidsCheck.checked;
    contest.ini.sigSpread = sigSpreadCheck ? sigSpreadCheck.checked : true;
    contest.me.myCall = contest.ini.call;
    contest.me.opName = contest.ini.hamName;
    contest.me.spc = contest.ini.mySpc;
    contest.me.cwtNr = contest.ini.myCwt;
    contest.updateBandConditions(prevFlags);
    persistSettings();
  }

  let saveTimer = null;
  let initialProfileLoaded = false;

  function buildSettingsPayload() {
    return {
      call: myCallInput.value.trim().toUpperCase() || "N9FZ",
      hamName: myNameInput.value.trim().toUpperCase() || "BOB",
      mySpc: mySpcInput.value.trim().toUpperCase() || "IN",
      myCwt: myCwtInput.value.trim().toUpperCase() || "2104",
      wpm: Number(wpmInput.value) || 20,
      pitch: Number(pitchSelect.value) || 600,
      bandWidth: Number(bwSelect.value) || 500,
      monVolumeDb: Number(monGainInput.value),
      qsk: qskCheck.checked,
      activity: Number(activityInput.value) || 3,
      duration: Number(durationInput.value) || 30,
      qrnModel: qrnModelSelect.value || "middleton",
      qrn: qrnCheck.checked,
      qrm: qrmCheck.checked,
      qsb: qsbCheck.checked,
      flutter: flutterCheck.checked,
      lids: lidsCheck.checked,
      sigSpread: sigSpreadCheck ? sigSpreadCheck.checked : true,
      mode: runModeSelect.value || "rmSst",
    };
  }

  function persistSettings() {
    const payload = buildSettingsPayload();
    try {
      localStorage.setItem("pymr_station_settings", JSON.stringify(payload));
    } catch (_e) {}

    if (!csrfToken) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch("/api/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(buildSettingsPayload()),
      }).catch(() => {});
    }, 350);
  }

  function applySavedSettings(s) {
    if (!s || typeof s !== "object") return;
    if (s.call) myCallInput.value = taintClean(s.call, /[^A-Z0-9/]/g, 15) || "N9FZ";
    if (s.hamName) myNameInput.value = taintClean(s.hamName, /[^A-Z]/g, 12) || "BOB";
    if (s.mySpc) mySpcInput.value = taintClean(s.mySpc, /[^A-Z0-9]/g, 6) || "IN";
    if (s.myCwt) myCwtInput.value = taintClean(s.myCwt, /[^A-Z0-9]/g, 8) || "2104";
    if (s.mode && MODE_TITLES[s.mode] && contest.ini.runMode === "rmStop") {
      runModeSelect.value = s.mode;
    }
    if (Number.isFinite(Number(s.wpm))) {
      const w = Math.max(5, Math.min(80, Number(s.wpm)));
      wpmInput.value = String(w);
      wpmQuickBadge.textContent = `${w} WPM`;
    }
    if (Number.isFinite(Number(s.pitch))) {
      pitchSelect.value = String(s.pitch);
    }
    if (Number.isFinite(Number(s.bandWidth))) {
      bwSelect.value = String(s.bandWidth);
      bwStatusText.textContent = `${s.bandWidth} Hz`;
    }
    if (Number.isFinite(Number(s.monVolumeDb))) {
      const m = Math.max(-30, Math.min(6, Number(s.monVolumeDb)));
      monGainInput.value = String(m);
      if (monGainValText) {
        monGainValText.textContent = m <= -30 ? "Mute" : `${m > 0 ? "+" : ""}${m} dB`;
      }
    }
    if (typeof s.qsk === "boolean") qskCheck.checked = s.qsk;
    if (Number.isFinite(Number(s.activity))) activityInput.value = String(s.activity);
    if (Number.isFinite(Number(s.duration))) {
      durationInput.value = String(Math.max(1, Math.min(60, Number(s.duration))));
    }
    if (s.qrnModel === "middleton" || s.qrnModel === "ve3nea") qrnModelSelect.value = s.qrnModel;
    if (typeof s.qrn === "boolean") qrnCheck.checked = s.qrn;
    if (typeof s.qrm === "boolean") qrmCheck.checked = s.qrm;
    if (typeof s.qsb === "boolean") qsbCheck.checked = s.qsb;
    if (typeof s.flutter === "boolean") flutterCheck.checked = s.flutter;
    if (typeof s.lids === "boolean") lidsCheck.checked = s.lids;
    if (typeof s.sigSpread === "boolean" && sigSpreadCheck) sigSpreadCheck.checked = s.sigSpread;

    syncModeLabels();
    contest.ini.call = myCallInput.value;
    contest.ini.hamName = myNameInput.value;
    contest.ini.mySpc = mySpcInput.value;
    contest.ini.myCwt = myCwtInput.value;
    contest.setWpm(Number(wpmInput.value) || 20);
    contest.setPitch(Number(pitchSelect.value) || 600);
    contest.setBandwidth(Number(bwSelect.value) || 500);
    contest.ini.monVolumeDb = Number(monGainInput.value);
    contest.ini.qsk = qskCheck.checked;
    contest.ini.activity = Number(activityInput.value) || 3;
    contest.ini.duration = Number(durationInput.value) || 30;
    contest.ini.qrnModel = qrnModelSelect.value;
    contest.ini.qrn = qrnCheck.checked;
    contest.ini.qrm = qrmCheck.checked;
    contest.ini.qsb = qsbCheck.checked;
    contest.ini.flutter = flutterCheck.checked;
    contest.ini.lids = lidsCheck.checked;
    contest.ini.sigSpread = sigSpreadCheck ? sigSpreadCheck.checked : true;
  }

  function startContest() {
    syncSettingsFromInputs();
    const mode = runModeSelect.value;

    if (mode === "rmWpx") {
      qrnCheck.checked = true;
      qrmCheck.checked = true;
      qsbCheck.checked = true;
      flutterCheck.checked = true;
      lidsCheck.checked = true;
      syncSettingsFromInputs();
    } else if (mode === "rmHst") {
      qrnCheck.checked = false;
      qrmCheck.checked = false;
      qsbCheck.checked = false;
      flutterCheck.checked = false;
      lidsCheck.checked = false;
      activityInput.value = "4";
      bwSelect.value = "600";
      syncSettingsFromInputs();
    }

    recordedBlocks = [];
    downloadWavBtn.disabled = true;
    crcBadgeText.textContent = "";

    contest.initRun(mode);
    syncModeLabels();
    wipeBoxes();
    renderLogTable();
    renderStats();
    drawHistogram();

    runToggleBtn.textContent = "\u25A0 Stop Contest";
    runToggleBtn.classList.remove("btn-primary");
    runToggleBtn.classList.add("btn-danger");
    runModeSelect.disabled = true;

    startAudioEngine();
    callInput.focus();
  }

  function stopContest() {
    const prevMode = contest.ini.runMode;
    const stats = contest.computeStats();
    contest.ini.runMode = "rmStop";
    stopAudioEngine();

    runToggleBtn.textContent = "\u25B6 Start Contest";
    runToggleBtn.classList.remove("btn-danger");
    runToggleBtn.classList.add("btn-primary");
    runModeSelect.disabled = false;
    txLed.classList.remove("transmitting");
    trxStateText.textContent = "Stopped";

    if (recordedBlocks.length > 0) {
      downloadWavBtn.disabled = false;
    }

    if (stats.rawQsos > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const scoreStr = `${today} ${contest.ini.call} ${stats.validQsos} ${stats.validMults} `;
      const crc = DSP.calculateCRC32(scoreStr);
      crcBadgeText.textContent = `[${crc}]`;

      fetch("/api/scores", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          call: contest.ini.call,
          mode: prevMode.replace(/^rm/, "").toUpperCase(),
          wpm: contest.ini.wpm,
          rawQsos: stats.rawQsos,
          validQsos: stats.validQsos,
          mults: stats.validMults,
          score: stats.validScore,
          crc,
        }),
      })
        .then((r) => {
          if (r.status === 401) window.location.href = "/login";
        })
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Entry Fields, Spacebar & N1MM ESM Logic (Main.pas)
  // ---------------------------------------------------------------------------
  function wipeBoxes() {
    callInput.value = "";
    exch1Input.value = "";
    exch2Input.value = "";
    contest.callSent = false;
    contest.nrSent = false;
    mustAdvance = false;
    callInput.focus();
  }

  function sendMsg(msg) {
    if (contest.ini.runMode === "rmStop") {
      startContest();
    }
    if (msg === "msgHisCall") {
      const c = callInput.value.trim().toUpperCase();
      if (c) contest.me.hisCall = c;
      contest.callSent = true;
    }
    if (msg === "msgNR") {
      contest.nrSent = true;
    }
    if (msg === "msgTU") {
      contest.me.hisName = isNameExchMode() ? exch1Input.value.trim().toUpperCase() : "";
    }
    contest.me.sendMsg(msg);
  }

  // Smart split if user types "BOB MA" inside exch1Input
  function normalizeExchangeBoxes() {
    if (isNameExchMode()) {
      const raw1 = exch1Input.value.trim().toUpperCase();
      if (raw1.includes(" ") && !exch2Input.value.trim()) {
        const parts = raw1.split(/\s+/);
        exch1Input.value = parts[0];
        exch2Input.value = parts.slice(1).join(" ");
      }
    } else {
      const raw2 = exch2Input.value.trim().toUpperCase();
      // Convert cut numbers T -> 0, O -> 0, N -> 9, A -> 1, E -> 5 in serial number box
      if (raw2) {
        exch2Input.value = raw2
          .replace(/T/g, "0")
          .replace(/O/g, "0")
          .replace(/N/g, "9")
          .replace(/[^0-9]/g, "");
      }
    }
  }

  function processSpace() {
    mustAdvance = false;
    normalizeExchangeBoxes();

    if (document.activeElement === callInput) {
      if (!isNameExchMode()) {
        if (!exch1Input.value.trim()) exch1Input.value = "599";
        exch2Input.focus();
      } else {
        exch1Input.focus();
      }
    } else if (document.activeElement === exch1Input) {
      if (!isNameExchMode() && !exch1Input.value.trim()) {
        exch1Input.value = "599";
      }
      exch2Input.focus();
    } else {
      callInput.focus();
    }
  }

  // Exact VE3NEA / N1MM ESM (Enter Sends Messages) state machine
  function processEnter(forceSaveOnly = false) {
    mustAdvance = false;
    normalizeExchangeBoxes();

    if (contest.ini.runMode === "rmStop") {
      startContest();
    }

    if (forceSaveOnly) {
      if (contest.saveQso(callInput.value, exch1Input.value, exch2Input.value)) {
        wipeBoxes();
      }
      return;
    }

    const callVal = callInput.value.trim().toUpperCase();
    if (!callVal) {
      sendMsg("msgCQ");
      return;
    }

    // Just "?" in Callsign box -> send "?" (agn) and stay in Callsign box
    if (/^\?+$/.test(callVal)) {
      callInput.value = "";
      sendMsg("msgQm");
      callInput.focus();
      return;
    }

    // Partial/uncertain callsign (contains "?" or < 3 chars, e.g. "W4?" or "W4"):
    // Send ONLY the partial call query (e.g. "W4?") and highlight the "?" so the
    // operator can immediately type the missing letters when the station replies.
    if (callVal.includes("?") || callVal.length < 3) {
      if (!callVal.includes("?")) {
        callInput.value = `${callVal}?`;
      }
      sendMsg("msgHisCall");
      contest.callSent = false;
      mustAdvance = true;
      return;
    }

    const c = contest.callSent;
    const n = contest.nrSent;
    const e1 = exch1Input.value.trim().toUpperCase();
    const e2 = exch2Input.value.trim().toUpperCase();
    const e1Valid = e1 !== "" && !e1.includes("?");
    const e2Valid = e2 !== "" && !e2.includes("?");
    const hasExch = isNameExchMode() ? e1Valid && e2Valid : e2Valid;

    if (!c || (!n && !hasExch)) {
      sendMsg("msgHisCall");
    }
    if (!n) {
      sendMsg("msgNR");
    }
    if (n && !hasExch) {
      if (isNameExchMode()) {
        if (!e1Valid && e2Valid) {
          sendMsg("msgNameQm");
        } else if (e1Valid && !e2Valid) {
          sendMsg("msgStQm");
        } else if (e1.includes("?")) {
          sendMsg("msgNameQm");
        } else {
          sendMsg("msgQm");
        }
      } else {
        sendMsg("msgQm");
      }
    }

    if (hasExch && (c || n)) {
      if (!isNameExchMode() && !exch1Input.value.trim()) {
        exch1Input.value = "599";
      }
      sendMsg("msgTU");
      if (contest.saveQso(callInput.value, exch1Input.value, exch2Input.value)) {
        wipeBoxes();
      }
    } else {
      mustAdvance = true;
    }
  }

  contest.onAdvanceCursor = () => {
    if (!mustAdvance) return;
    if (callInput.value.includes("?")) {
      callInput.focus();
      const qIdx = callInput.value.indexOf("?");
      if (qIdx >= 0) {
        callInput.setSelectionRange(qIdx, callInput.value.length);
      }
    } else if (isNameExchMode()) {
      const e1 = exch1Input.value.trim();
      const e2 = exch2Input.value.trim();
      if (!e1 || e1.includes("?")) {
        exch1Input.focus();
        const qIdx = exch1Input.value.indexOf("?");
        if (qIdx >= 0) {
          exch1Input.setSelectionRange(qIdx, exch1Input.value.length);
        }
      } else if (!e2 || e2.includes("?")) {
        exch2Input.focus();
        const qIdx = exch2Input.value.indexOf("?");
        if (qIdx >= 0) {
          exch2Input.setSelectionRange(qIdx, exch2Input.value.length);
        }
      } else {
        exch1Input.focus();
      }
    } else {
      if (!exch1Input.value.trim()) {
        exch1Input.value = "599";
      }
      exch2Input.focus();
    }
    mustAdvance = false;
  };

  // Live Callsign Update while Sending (MyStn.pas UpdateCallInMessage) + Strict ASCII Taint Check
  callInput.addEventListener("input", () => {
    callInput.value = taintClean(callInput.value, /[^A-Z0-9/?]/g, 15);
    if (!callInput.value) {
      contest.nrSent = false;
    }
    if (!contest.me.updateCallInMessage(callInput.value)) {
      contest.callSent = false;
    }
  });

  exch1Input.addEventListener("input", () => {
    const val = taintClean(exch1Input.value, /[^A-Z0-9?\s]/g, 12);
    if (isNameExchMode() && val.endsWith(" ") && val.trim().length > 0) {
      exch1Input.value = val.trim();
      exch2Input.focus();
    } else {
      exch1Input.value = val;
    }
  });

  exch2Input.addEventListener("input", () => {
    exch2Input.value = taintClean(exch2Input.value, /[^A-Z0-9?]/g, 10);
  });

  myCallInput.addEventListener("input", () => {
    myCallInput.value = taintClean(myCallInput.value, /[^A-Z0-9/]/g, 15);
    contest.ini.call = myCallInput.value || "N9FZ";
    contest.me.myCall = contest.ini.call;
    persistSettings();
  });
  myNameInput.addEventListener("input", () => {
    myNameInput.value = taintClean(myNameInput.value, /[^A-Z]/g, 12);
    contest.ini.hamName = myNameInput.value || "BOB";
    contest.me.opName = contest.ini.hamName;
    persistSettings();
  });
  mySpcInput.addEventListener("input", () => {
    mySpcInput.value = taintClean(mySpcInput.value, /[^A-Z0-9]/g, 6);
    contest.ini.mySpc = mySpcInput.value || "IN";
    contest.me.spc = contest.ini.mySpc;
    persistSettings();
  });
  myCwtInput.addEventListener("input", () => {
    myCwtInput.value = taintClean(myCwtInput.value, /[^A-Z0-9]/g, 8);
    contest.ini.myCwt = myCwtInput.value || "2104";
    contest.me.cwtNr = contest.ini.myCwt;
    persistSettings();
  });

  // ---------------------------------------------------------------------------
  // Keyboard Shortcuts (F1-F8, Enter, Space, Esc, Alt+W, Arrows, PgUp/PgDn)
  // ---------------------------------------------------------------------------
  const FKEY_MAP = {
    F1: "msgCQ",
    F2: "msgNR",
    F3: "msgTU",
    F4: "msgMyCall",
    F5: "msgHisCall",
    F6: "msgB4",
    F7: "msgQm",
    F8: "msgNil",
  };

  window.addEventListener("keydown", (e) => {
    if (FKEY_MAP[e.key]) {
      e.preventDefault();
      if (e.key === "F7" && isNameExchMode() && contest.nrSent) {
        if (document.activeElement === exch1Input) {
          sendMsg("msgNameQm");
          return;
        }
        if (document.activeElement === exch2Input) {
          sendMsg("msgStQm");
          return;
        }
      }
      sendMsg(FKEY_MAP[e.key]);
      return;
    }

    if (e.key === "F11" || ((e.altKey || e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w")) {
      e.preventDefault();
      wipeBoxes();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (contest.me.msg.has("msgHisCall")) contest.callSent = false;
      if (contest.me.msg.has("msgNR")) contest.nrSent = false;
      contest.me.abortSend();
      return;
    }

    const target = e.target;
    const isEntryBox =
      target === callInput || target === exch1Input || target === exch2Input;
    const isOtherFormControl =
      !isEntryBox &&
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "SELECT" ||
        target.tagName === "TEXTAREA");

    if (isOtherFormControl) {
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const forceSave = e.ctrlKey || e.shiftKey || e.altKey;
      processEnter(forceSave);
      return;
    }

    if (e.key === " " && (
      document.activeElement === callInput ||
      document.activeElement === exch1Input ||
      document.activeElement === exch2Input
    )) {
      e.preventDefault();
      processSpace();
      return;
    }

    if (e.key === ";" || e.key === "Insert") {
      e.preventDefault();
      sendMsg("msgHisCall");
      sendMsg("msgNR");
      return;
    }

    if (e.key === "+" || e.key === "." || e.key === "," || e.key === "[") {
      e.preventDefault();
      normalizeExchangeBoxes();
      if (!isNameExchMode() && !exch1Input.value.trim()) {
        exch1Input.value = "599";
      }
      if (!contest.callSent) sendMsg("msgHisCall");
      sendMsg("msgTU");
      if (contest.saveQso(callInput.value, exch1Input.value, exch2Input.value)) {
        wipeBoxes();
      }
      return;
    }

    if (e.key === "\\") {
      e.preventDefault();
      sendMsg("msgCQ");
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (e.ctrlKey) {
        adjustBandwidth(50);
      } else {
        adjustRit(50);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (e.ctrlKey) {
        adjustBandwidth(-50);
      } else {
        adjustRit(-50);
      }
      return;
    }

    if (e.key === "PageUp" || ((e.altKey || e.ctrlKey) && e.key === "F10")) {
      e.preventDefault();
      const step = isNameExchMode() ? 2 : 5;
      adjustWpm(step);
      return;
    }

    if (e.key === "PageDown" || ((e.altKey || e.ctrlKey) && e.key === "F9")) {
      e.preventDefault();
      const step = isNameExchMode() ? -2 : -5;
      adjustWpm(step);
      return;
    }
  });

  function adjustRit(deltaHz) {
    if (deltaHz === 0) contest.ini.rit = 0;
    else contest.ini.rit = Math.max(-500, Math.min(500, contest.ini.rit + deltaHz));
    ritValueText.textContent = `${contest.ini.rit >= 0 ? "+" : ""}${contest.ini.rit} Hz`;
  }

  function adjustBandwidth(deltaHz) {
    const nextBw = Math.max(150, Math.min(600, contest.ini.bandWidth + deltaHz));
    contest.setBandwidth(nextBw);
    bwSelect.value = String(nextBw);
    bwStatusText.textContent = `${nextBw} Hz`;
  }

  function adjustWpm(delta) {
    const maxWpm = runModeSelect.value === "rmSst" ? 20 : 80;
    const nextWpm = Math.max(5, Math.min(maxWpm, contest.ini.wpm + delta));
    contest.setWpm(nextWpm);
    wpmInput.value = String(nextWpm);
    wpmQuickBadge.textContent = `${nextWpm} WPM`;
  }

  // ---------------------------------------------------------------------------
  // UI Button & Control Listeners
  // ---------------------------------------------------------------------------
  runToggleBtn.addEventListener("click", () => {
    if (contest.ini.runMode === "rmStop") startContest();
    else stopContest();
  });

  runModeSelect.addEventListener("change", () => {
    syncModeLabels();
    persistSettings();
  });
  wipeBtn.addEventListener("click", wipeBoxes);

  document.querySelectorAll(".fkey-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const msg = btn.getAttribute("data-msg");
      if (msg) sendMsg(msg);
      callInput.focus();
    });
  });

  ritDownBtn.addEventListener("click", () => adjustRit(-50));
  ritResetBtn.addEventListener("click", () => adjustRit(0));
  ritUpBtn.addEventListener("click", () => adjustRit(50));

  wpmInput.addEventListener("change", () => {
    contest.setWpm(Number(wpmInput.value) || 20);
    wpmQuickBadge.textContent = `${contest.ini.wpm} WPM`;
    persistSettings();
  });

  pitchSelect.addEventListener("change", () => {
    contest.setPitch(Number(pitchSelect.value) || 600);
    persistSettings();
  });

  bwSelect.addEventListener("change", () => {
    const bw = Number(bwSelect.value) || 500;
    contest.setBandwidth(bw);
    bwStatusText.textContent = `${bw} Hz`;
    persistSettings();
  });

  monGainInput.addEventListener("input", () => {
    const val = Number(monGainInput.value);
    contest.ini.monVolumeDb = Number.isFinite(val) ? val : -6;
    if (monGainValText) {
      monGainValText.textContent =
        contest.ini.monVolumeDb <= -30
          ? "Mute"
          : `${contest.ini.monVolumeDb > 0 ? "+" : ""}${contest.ini.monVolumeDb} dB`;
    }
    persistSettings();
  });

  qskCheck.addEventListener("change", () => {
    contest.ini.qsk = qskCheck.checked;
    persistSettings();
  });

  activityInput.addEventListener("change", syncSettingsFromInputs);
  durationInput.addEventListener("change", syncSettingsFromInputs);

  qrnModelSelect.addEventListener("change", () => {
    contest.ini.qrnModel = qrnModelSelect.value;
    persistSettings();
  });

  [qrnCheck, qrmCheck, qsbCheck, flutterCheck, lidsCheck, sigSpreadCheck].forEach((chk) => {
    if (chk) chk.addEventListener("change", syncSettingsFromInputs);
  });

  // ---------------------------------------------------------------------------
  // Built-in Master.dta (50k calls) + K1USNSST.txt (11.3k) + CWOPS.LIST (7.1k)
  // and Custom Call History / Master.dta Upload
  // ---------------------------------------------------------------------------
  async function loadBuiltInDatabases() {
    try {
      const [sstResp, cwtResp, masterResp] = await Promise.all([
        fetch("/static/K1USNSST.txt"),
        fetch("/static/CWOPS.LIST"),
        fetch("/static/Master.dta"),
      ]);
      if (sstResp.ok) {
        const sstText = await sstResp.text();
        const parsedSst = ContestEngine.parseCallHistoryText(sstText);
        if (parsedSst.length > 0) {
          contest.sstRoster = parsedSst;
        }
      }
      if (cwtResp.ok) {
        const cwtText = await cwtResp.text();
        const parsedCwt = ContestEngine.parseCallHistoryText(cwtText);
        if (parsedCwt.length > 0) {
          contest.cwtRoster = parsedCwt;
        }
      }
      if (masterResp.ok) {
        const masterBuf = await masterResp.arrayBuffer();
        const parsedMaster = ContestEngine.parseMasterDta(masterBuf);
        if (parsedMaster.length > 0) {
          contest.masterRoster = parsedMaster;
        }
      }
      if (contest.ini.runMode === "rmStop") {
        contest.resetPool();
      }
    } catch (_e) {
      // Fallback to built-in DEFAULT_ROSTER if offline
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering QSO Log, Score Table & Histogram
  // ---------------------------------------------------------------------------
  function renderLogTable() {
    logTableBody.textContent = "";
    for (const qso of contest.qsoList) {
      const tr = document.createElement("tr");

      const tdUtc = document.createElement("td");
      tdUtc.textContent = qso.timeStr;

      const tdCall = document.createElement("td");
      tdCall.textContent = qso.call;

      const tdRecv = document.createElement("td");
      tdRecv.textContent = `${qso.recv1} ${qso.recv2}`;

      const tdSent = document.createElement("td");
      tdSent.textContent = `${qso.sent1} ${qso.sent2}`;

      const tdMult = document.createElement("td");
      tdMult.textContent = qso.pfx;

      const tdChk = document.createElement("td");
      const errTrim = qso.err.trim();
      if (errTrim === "") {
        tdChk.textContent = "OK";
        tdChk.className = "ok-badge";
      } else {
        tdChk.textContent = errTrim;
        tdChk.className = "err-badge";
      }

      tr.append(tdUtc, tdCall, tdRecv, tdSent, tdMult, tdChk);
      logTableBody.appendChild(tr);
    }
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function renderStats() {
    const s = contest.computeStats();
    rawPtsCell.textContent = String(s.rawQsos);
    valPtsCell.textContent = String(s.validQsos);
    rawMulCell.textContent = String(s.rawMults);
    valMulCell.textContent = String(s.validMults);
    rawScoreCell.textContent = String(s.rawScore);
    valScoreCell.textContent = String(s.validScore);
  }

  function drawHistogram() {
    const ctx = histoCanvas.getContext("2d");
    const w = histoCanvas.width;
    const h = histoCanvas.height;
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, w, h);

    // 5-minute buckets (up to 24 buckets = 120m)
    const buckets = new Int32Array(24);
    for (const q of contest.qsoList) {
      const b = Math.min(23, Math.floor(q.tSec / 300));
      buckets[b]++;
    }

    // Grid lines
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 1;
    for (let y = h - 10; y > 10; y -= 20) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const barW = Math.floor((w - 16) / 24);
    ctx.fillStyle = "#22c55e";
    for (let i = 0; i < 24; i++) {
      const cnt = buckets[i];
      if (cnt > 0) {
        const barH = Math.min(h - 14, cnt * 3);
        ctx.fillRect(8 + i * barW, h - 6 - barH, barW - 2, barH);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Live S-Meter, Passband & Waveform Visualizer Loop
  // ---------------------------------------------------------------------------
  let smoothedSMeter = 0.08;
  const SMETER_LABELS = [
    "S1",
    "S2",
    "S3",
    "S4",
    "S5",
    "S6",
    "S7",
    "S8",
    "S9",
    "S9+10",
    "S9+20",
  ];

  function updateSMeter(isRunning, isTx) {
    let target = 0.08;
    if (isRunning && !isTx && lastAudioBlock.length > 0) {
      let sumSq = 0;
      for (let i = 0; i < lastAudioBlock.length; i++) {
        const norm = lastAudioBlock[i] / 20000.0;
        sumSq += norm * norm;
      }
      const rms = Math.sqrt(sumSq / lastAudioBlock.length);
      const agcBoost = Math.min(0.35, contest.agc.lastGainReductionDb / 40.0);
      target = Math.max(0.1, Math.min(1.0, Math.sqrt(rms) * 0.9 + agcBoost));
    } else if (isTx) {
      target = 0.05;
    }

    // Fast attack, smooth decay (classic S-meter ballistics)
    const alpha = target > smoothedSMeter ? 0.35 : 0.1;
    smoothedSMeter += alpha * (target - smoothedSMeter);

    const sctx = smeterCanvas.getContext("2d");
    const sw = smeterCanvas.width;
    const sh = smeterCanvas.height;
    sctx.fillStyle = "#090d16";
    sctx.fillRect(0, 0, sw, sh);

    const segments = 11;
    const activeSegs = isRunning
      ? Math.max(1, Math.min(segments, Math.round(smoothedSMeter * segments)))
      : 1;
    const segW = Math.floor((sw - 4) / segments);

    for (let i = 0; i < segments; i++) {
      if (i < activeSegs) {
        sctx.fillStyle = i < 8 ? "#22c55e" : i === 8 ? "#eab308" : "#ef4444";
      } else {
        sctx.fillStyle = "#1e293b";
      }
      sctx.fillRect(2 + i * segW, 2, segW - 2, sh - 4);
    }

    smeterText.textContent = isRunning ? SMETER_LABELS[activeSegs - 1] : "S0";
  }

  function drawPassband() {
    const ctx = passbandCanvas.getContext("2d");
    const w = passbandCanvas.width;
    const h = passbandCanvas.height;
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, w, h);

    const centerX = w / 2;
    const hzToPx = w / 1200; // -600 Hz to +600 Hz around center Pitch

    // Draw Receiver IF Bandwidth + RIT Passband Window
    const bwPx = contest.ini.bandWidth * hzToPx;
    const ritPx = contest.ini.rit * hzToPx;
    ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
    ctx.fillRect(centerX + ritPx - bwPx / 2, 0, bwPx, h);

    ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(centerX + ritPx - bwPx / 2, 1, bwPx, h - 2);

    // Center pitch marker
    ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Active DX & QRM Station carriers in passband
    const callers = contest.activeDxStations();
    for (const c of callers) {
      const x = centerX + c.pitchOffset * hzToPx;
      const isTx = c.state === ContestEngine.ST.Sending;
      if (c.isQrm) {
        ctx.strokeStyle = isTx ? "#f59e0b" : "#92400e";
      } else {
        ctx.strokeStyle = isTx ? "#22c55e" : "#64748b";
      }
      ctx.lineWidth = isTx ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(x, h - 4);
      ctx.lineTo(x, isTx ? 16 : h - 22);
      ctx.stroke();

      if (isTx) {
        ctx.fillStyle = c.isQrm ? "#fbbf24" : "#4ade80";
        ctx.font = "bold 10px monospace";
        ctx.fillText(c.isQrm ? "QRM" : `${c.wpm}w`, x - 10, 12);
      }
    }

    // Draw live audio waveform trace along bottom half
    const isRunning = contest.ini.runMode !== "rmStop";
    const isMeSending = contest.me.state === ContestEngine.ST.Sending;
    if (isRunning && lastAudioBlock.length > 0) {
      ctx.strokeStyle = isMeSending ? "#f87171" : "#38bdf8";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(lastAudioBlock.length / w));
      for (let x = 0; x < w; x++) {
        const sample = lastAudioBlock[Math.min(lastAudioBlock.length - 1, x * step)] / 25000.0;
        const y = h * 0.65 - sample * (h * 0.28);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Update TX LED & S-Meter (Fixed width, zero jitter)
    txLed.classList.toggle("transmitting", isMeSending);
    if (isRunning) {
      trxStateText.textContent = isMeSending ? "TX Sending" : "RX Listen";
    }
    updateSMeter(isRunning, isMeSending);

    requestAnimationFrame(drawPassband);
  }

  // ---------------------------------------------------------------------------
  // Contest Engine Event Hooks & Exports
  // ---------------------------------------------------------------------------
  contest.onQsoUpdated = () => {
    renderLogTable();
    renderStats();
    drawHistogram();
  };

  contest.onContestEnded = () => {
    stopContest();
  };

  contest.onTickStatus = (elapsedSec) => {
    const mins = Math.floor(elapsedSec / 60);
    const secs = Math.floor(elapsedSec % 60);
    const hrs = Math.floor(mins / 60);
    const clock = `${String(hrs).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    const rate = contest.computeRate();
    const dxCnt = contest.dxCount();
    clockAndRateLabel.textContent = `${clock} \u2022 Rate: ${rate} QSO/hr \u2022 Pileup: ${dxCnt}`;
  };

  // Export Cabrillo / ADIF via Backend API
  async function exportLog(format) {
    const endpoint = format === "adif" ? "/api/export/adif" : "/api/export/cabrillo";
    const modeCode = runModeSelect.value.replace(/^rm/, "").toUpperCase();
    const payload = {
      myCall: contest.ini.call,
      myName: contest.ini.hamName,
      mySpc: contest.ini.mySpc,
      mode: modeCode,
      qsos: contest.qsoList,
    };

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(payload),
    });
    if (resp.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!resp.ok) return;

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${contest.ini.call}_${modeCode}.${format === "adif" ? "adi" : "log"}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  exportCabrilloBtn.addEventListener("click", () => exportLog("cabrillo"));
  exportAdifBtn.addEventListener("click", () => exportLog("adif"));

  // Export Recorded WAV Audio (WavFile.pas equivalent)
  downloadWavBtn.addEventListener("click", () => {
    if (recordedBlocks.length === 0) return;
    const totalSamples = recordedBlocks.reduce((acc, b) => acc + b.length, 0);
    const wavBuffer = new ArrayBuffer(44 + totalSamples * 2);
    const view = new DataView(wavBuffer);

    const writeStr = (offset, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + totalSamples * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, DSP.DEFAULTRATE, true);
    view.setUint32(28, DSP.DEFAULTRATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, totalSamples * 2, true);

    let offset = 44;
    for (const blk of recordedBlocks) {
      for (let i = 0; i < blk.length; i++) {
        const s = Math.max(-32767, Math.min(32767, Math.round(blk[i])));
        view.setInt16(offset, s, true);
        offset += 2;
      }
    }

    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pyMorseRunner_${contest.ini.call}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // Session Verification (Optional Auth0 for Admin, Public Visitor CSRF & Telemetry)
  async function verifySessionAndLoadUser() {
    try {
      const resp = await fetch("/api/me");
      if (resp.status === 401) {
        if (contest.ini.runMode !== "rmStop") stopContest();
        window.location.href = "/login?error=kicked_or_expired";
        return;
      }
      if (!resp.ok) return;
      const data = await resp.json();
      csrfToken = data.csrfToken || "";
      if (data.authenticated && data.user) {
        if (userInfoChip) {
          userInfoChip.textContent = `${data.user.name} (${data.user.role.toUpperCase()})`;
          userInfoChip.hidden = false;
        }
        if (adminPortalLink) {
          adminPortalLink.hidden = data.user.role !== "admin";
        }
        if (signOutLink) {
          signOutLink.hidden = false;
        }
      } else {
        if (userInfoChip) userInfoChip.hidden = true;
        if (adminPortalLink) adminPortalLink.hidden = true;
        if (signOutLink) signOutLink.hidden = true;
      }

      if (!initialProfileLoaded) {
        initialProfileLoaded = true;
        if (data.user && data.user.settings && Object.keys(data.user.settings).length > 0) {
          applySavedSettings(data.user.settings);
          try {
            localStorage.setItem("pymr_station_settings", JSON.stringify(data.user.settings));
          } catch (_e) {}
        } else {
          persistSettings();
        }
      }
    } catch (_e) {
      // Ignore transient network hiccup
    }
  }

  // Restore cached settings from localStorage immediately, then sync with Auth0 user profile
  try {
    const cached = localStorage.getItem("pymr_station_settings");
    if (cached) {
      applySavedSettings(JSON.parse(cached));
    }
  } catch (_e) {}

  // Initial setup
  verifySessionAndLoadUser();
  loadBuiltInDatabases();
  setInterval(verifySessionAndLoadUser, 15000);
  syncModeLabels();
  drawHistogram();
  requestAnimationFrame(drawPassband);
})();
