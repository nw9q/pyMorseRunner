/**
 * Morse Runner Contest & Caller AI Engine
 * Ported from VE3NEA Morse Runner 1.68 (Station.pas, MyStn.pas, DxStn.pas,
 * DxOper.pas, QrmStn.pas, QrnStn.pas, CallLst.pas, Log.pas, Contest.pas)
 * with native support for:
 *  - K1USN SST (Slow Speed Test: Name + State/Province/DX, <= 20 WPM)
 *  - CWops CWT (Name + Member# / SPC)
 *  - CQ WPX / Pile-Up / Single Calls / HST Competition
 *  - Middleton Class B / Pareto Sferic QRN synthesis
 */

"use strict";

const ContestEngine = (() => {
  const {
    DEFAULTRATE,
    DEFAULTBUFSIZE,
    TWO_PI,
    NEVER,
    rndGaussLim,
    rndRayleigh,
    rndUShaped,
    rndPoisson,
    secondsToBlocks,
    blocksToSeconds,
    MorseKeyer,
    Qsb,
    MovingAverage,
    Modulator,
    VolumeControl,
  } = DSP;

  // Built-in roster with Callsign, Operator Name, State/Province/DX (for SST), and CWT Nr
  const DEFAULT_ROSTER = [
    ["K1USN", "PIETER", "MA", "1042"], ["W1AW", "HIRAM", "CT", "1"],
    ["VE3NEA", "ALEX", "ON", "1120"], ["W7SST", "MIKE", "OR", "2415"],
    ["K9MA", "SCOTT", "WI", "1388"], ["N9FZ", "BOB", "IN", "2104"],
    ["W9RE", "MIKE", "IN", "412"], ["K9NW", "MIKE", "IN", "305"],
    ["WT9U", "JIM", "IN", "892"], ["K9WX", "TIM", "IN", "1015"],
    ["N4AF", "HOWIE", "NC", "88"], ["K4BAI", "JOHN", "GA", "112"],
    ["W4OC", "DON", "SC", "514"], ["N4ZZ", "DON", "TN", "219"],
    ["K3WW", "CHAS", "PA", "74"], ["AA3B", "BUD", "PA", "51"],
    ["N3RD", "DAVE", "PA", "195"], ["K3UL", "BOB", "PA", "640"],
    ["W2GD", "JOHN", "NJ", "92"], ["N2NT", "ANDY", "NJ", "63"],
    ["K2TW", "TOM", "NJ", "1409"], ["WA2VYA", "RICH", "TX", "910"],
    ["K5ZD", "RANDY", "MA", "42"], ["W1WEF", "JACK", "CT", "130"],
    ["K1GQ", "BILL", "NH", "85"], ["AE1T", "PETER", "NH", "1725"],
    ["W1KM", "GREG", "MA", "310"], ["N1LN", "BRUCE", "NC", "440"],
    ["K1VUT", "DAVE", "MA", "1980"], ["KB1W", "LARRY", "MA", "715"],
    ["N8AA", "JOHN", "OH", "37"], ["K8MR", "JIM", "OH", "109"],
    ["W8FJ", "TED", "PA", "145"], ["W8CAR", "DAN", "OH", "1182"],
    ["KV8Q", "TOM", "OH", "1630"], ["NA8V", "GREG", "MI", "502"],
    ["K8ZT", "ANTHONY", "OH", "2290"], ["AB9YC", "BILL", "IL", "1812"],
    ["K9ZO", "RALPH", "IL", "624"], ["W9ILY", "JOHN", "IL", "490"],
    ["N0AX", "WARD", "MO", "215"], ["K0AD", "AL", "MN", "338"],
    ["W0TG", "BILL", "TX", "1275"], ["K0VBU", "BILL", "KS", "842"],
    ["N0TA", "JOHN", "CO", "885"], ["K0DTJ", "BRIAN", "CA", "1540"],
    ["N5TJ", "JEFF", "TX", "99"], ["K5TR", "GEO", "TX", "210"],
    ["K5PI", "ROB", "TX", "611"], ["W5TM", "ED", "OK", "740"],
    ["N5RZ", "GATOR", "TX", "588"], ["NM5M", "ERIC", "TX", "944"],
    ["K5KU", "DARB", "LA", "1210"], ["AD5A", "MIKE", "TX", "472"],
    ["N6TR", "TREE", "OR", "12"], ["N6TV", "BOB", "CA", "84"],
    ["K6RB", "ROB", "CA", "6"], ["W6SX", "HANK", "CA", "381"],
    ["K6NR", "DANA", "CA", "712"], ["N6XI", "RICK", "CA", "394"],
    ["K7QA", "TOM", "MT", "1105"], ["K7SV", "LAR", "VA", "275"],
    ["W7SW", "SCOT", "AZ", "690"], ["N7US", "JIM", "IL", "533"],
    ["WJ9B", "WILL", "ID", "1008"], ["K7NEW", "EARL", "WA", "2190"],
    ["VE2FK", "CLAUDE", "QC", "418"], ["VE3KI", "RICH", "ON", "604"],
    ["VE3EJ", "JOHN", "ON", "77"], ["VE3YT", "VIC", "ON", "1340"],
    ["VA3SB", "SERGE", "ON", "1622"], ["VE7KW", "KEITH", "BC", "1490"],
    ["VE6RST", "STEVE", "AB", "1902"], ["VE1DT", "GERRY", "NS", "815"],
    ["VY2ZM", "JEFF", "PE", "180"], ["VO1HP", "FRANK", "NL", "930"],
    ["DL6KVA", "AXEL", "DX", "320"], ["DJ1YFK", "FAB", "DX", "240"],
    ["G4BUO", "DAVE", "DX", "155"], ["G3XLG", "RAY", "DX", "980"],
    ["GM3WOJ", "CHRIS", "DX", "410"], ["PA4N", "FRANK", "DX", "520"],
    ["ON4UN", "JOHN", "DX", "45"], ["F6HKA", "BERT", "DX", "730"],
    ["SM5IMO", "DAN", "DX", "612"], ["OH2BH", "MARTTI", "DX", "15"],
    ["I2WIJ", "BOB", "DX", "312"], ["EA5FID", "JUAN", "DX", "845"],
    ["S59ABC", "MARKO", "DX", "1102"], ["9A5W", "NIK", "DX", "488"],
    ["LY9A", "GED", "DX", "670"], ["YL2VW", "AGRIS", "DX", "912"],
    ["HA3NU", "LACI", "DX", "540"], ["OK1RR", "MARTIN", "DX", "388"],
    ["OM3BH", "NANO", "DX", "704"], ["SP2LNW", "SLAW", "DX", "832"],
    ["JA1BJI", "HIRO", "DX", "1240"], ["JH1EAQ", "KEN", "DX", "1520"],
    ["VK2IA", "BERND", "DX", "990"], ["ZL3IO", "HOLGER", "DX", "650"],
    ["PY2NY", "VITOR", "DX", "1150"], ["LU1FAM", "FER", "DX", "1410"],
    ["KH6LC", "LLOYD", "HI", "580"], ["KL7SB", "STEVE", "AK", "1025"],
    ["KP4AA", "CARLOS", "PR", "1310"], ["NP2X", "ED", "VI", "795"],
    ["WA3AAN", "GRANT", "PA", "1645"], ["WB4IT", "JOHN", "AL", "2310"],
    ["KC4D", "BILL", "VA", "905"], ["W4SPR", "JACK", "FL", "1480"],
    ["N4BP", "BOB", "FL", "162"], ["K4RO", "KIRK", "TN", "178"],
    ["W3LPL", "FRANK", "MD", "19"], ["K3LR", "TIM", "PA", "22"],
    ["N3JT", "JIM", "VA", "134"], ["K3SEN", "DALE", "PA", "1870"],
    ["N2IC", "STEVE", "NM", "55"], ["K2PO", "CLINT", "OR", "680"],
    ["W2RQ", "BILL", "NJ", "430"], ["N1DC", "RICK", "MA", "1422"],
    ["W1UE", "DENNIS", "MA", "365"], ["K1DJ", "RICH", "MA", "1595"],
    ["AB1BX", "NED", "RI", "1940"], ["K1RV", "PI", "MA", "812"],
    ["W1RM", "PETE", "CT", "290"], ["K1ESE", "JOHN", "ME", "1175"],
    ["N1ZX", "STEVE", "VT", "2050"], ["KA1YQC", "DAVE", "NH", "2410"],
    ["AK4EX", "STUART", "TN", "1890"], ["W3DQ", "ERIC", "DC", "1780"]
  ];

  // Operator states (DxOper.pas)
  const OS = {
    NeedPrevEnd: "osNeedPrevEnd",
    NeedQso: "osNeedQso",
    NeedNr: "osNeedNr",
    NeedCall: "osNeedCall",
    NeedCallNr: "osNeedCallNr",
    NeedEnd: "osNeedEnd",
    Done: "osDone",
    Failed: "osFailed",
  };

  // Station states (Station.pas)
  const ST = {
    Listening: "stListening",
    Copying: "stCopying",
    PreparingToSend: "stPreparingToSend",
    Sending: "stSending",
  };

  // Station events
  const EV = {
    Timeout: "evTimeout",
    MsgSent: "evMsgSent",
    MeStarted: "evMeStarted",
    MeFinished: "evMeFinished",
  };

  const FULL_PATIENCE = 5;

  // ---------------------------------------------------------------------------
  // ExtractPrefix (Log.pas)
  // ---------------------------------------------------------------------------
  function extractPrefix(callRaw) {
    let call = String(callRaw || "").toUpperCase().trim() + "|";
    call = call
      .replace("/QRP|", "")
      .replace("/MM|", "")
      .replace("/M|", "")
      .replace("/P|", "")
      .replace(/\|/g, "")
      .replace(/\/\//g, "/");
    if (call.length < 2) return "";

    let dig = "";
    const p = call.indexOf("/");
    let res = "";
    if (p === -1) {
      res = call;
    } else if (p === 0) {
      res = call.slice(1);
    } else if (p === call.length - 1) {
      res = call.slice(0, p);
    } else {
      const s1 = call.slice(0, p);
      const s2 = call.slice(p + 1);
      if (s1.length === 1 && /^[0-9]$/.test(s1)) {
        dig = s1;
        res = s2;
      } else if (s2.length === 1 && /^[0-9]$/.test(s2)) {
        dig = s2;
        res = s1;
      } else {
        res = s1.length <= s2.length ? s1 : s2;
      }
    }
    if (res.includes("/")) return "";

    while (res.length >= 3 && !/[0-9]/.test(res[res.length - 1])) {
      res = res.slice(0, -1);
    }
    if (!/[0-9]/.test(res[res.length - 1])) {
      res += "0";
    }
    if (dig !== "") {
      res = res.slice(0, -1) + dig;
    }
    return res.slice(0, 5);
  }

  // Extract CountryPrefix for K1USNSST.udc Multiplier2 (DXc, DoNotCountMultOnlyFor2 = K, VE)
  function extractDxccPrefix(callRaw) {
    const pfx = extractPrefix(callRaw);
    if (!pfx) return "DX";
    const stripped = pfx.replace(/[0-9]+$/, "");
    if (!stripped) return pfx;
    if (/^[0-9]/.test(pfx) && stripped.length === 1) {
      return pfx.slice(0, 2);
    }
    if (/^D[A-R]$/.test(stripped)) return "DL";
    if (/^J[A-S]$/.test(stripped)) return "JA";
    return stripped;
  }

  function isUsOrCanadaCall(callRaw) {
    const c = String(callRaw || "").toUpperCase().trim();
    if (/^(KH6|KL7|KP4|NP2|KP2)/.test(c)) return false;
    return /^(K|W|N|A[A-L]|VE|VA|VO|VY)/.test(c);
  }

  // ---------------------------------------------------------------------------
  // CallToScore (Log.pas — IARU HST character weight calculation)
  // ---------------------------------------------------------------------------
  function callToScore(call, keyer) {
    const encoded = keyer.encode(call);
    let score = -1;
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === ".") score += 2;
      else if (encoded[i] === "-") score += 4;
      else if (encoded[i] === " ") score += 2;
    }
    return Math.max(1, score);
  }

  // ---------------------------------------------------------------------------
  // Base TStation (Station.pas)
  // ---------------------------------------------------------------------------
  class Station {
    constructor(contest) {
      this.contest = contest;
      this.bfo = 0.0;
      this.dPhi = 0.0;
      this._pitch = 0;
      this.sendPos = 0;
      this.timeOut = NEVER;
      this.nrWithError = false;
      this.amplitude = 15000;
      this.wpm = 25;
      this.envelope = null;
      this.state = ST.Listening;
      this.nr = 1;
      this.rst = 599;
      this.myCall = "";
      this.hisCall = "";
      this.opName = "BOB";
      this.spc = "MA";
      this.cwtNr = "1042";
      this.msg = new Set();
      this.msgText = "";
    }

    get pitch() {
      return this._pitch;
    }

    set pitch(val) {
      this._pitch = val;
      this.dPhi = (TWO_PI * this._pitch) / DEFAULTRATE;
    }

    getBfo() {
      const res = this.bfo;
      this.bfo += this.dPhi;
      if (this.bfo > TWO_PI) this.bfo -= TWO_PI;
      return res;
    }

    getBlock() {
      if (!this.envelope) {
        return new Float32Array(this.contest.ini.bufSize);
      }
      const bufSize = this.contest.ini.bufSize;
      const slice = this.envelope.subarray(this.sendPos, this.sendPos + bufSize);
      const out = new Float32Array(bufSize);
      out.set(slice);
      this.sendPos += bufSize;
      if (this.sendPos >= this.envelope.length) {
        this.envelope = null;
      }
      return out;
    }

    nrAsText() {
      const mode = this.contest.ini.runMode;
      if (mode === "rmSst") {
        if (this.nrWithError) {
          this.nrWithError = false;
          return `${this.opName} ${this.spc[0]} EEEEE ${this.spc}`;
        }
        return `${this.opName} ${this.spc}`;
      }
      if (mode === "rmCwt") {
        const exch2 = Math.random() < 0.8 ? this.cwtNr : this.spc;
        if (this.nrWithError) {
          this.nrWithError = false;
          return `${this.opName} EEEEE ${this.opName} ${exch2}`;
        }
        return `${this.opName} ${exch2}`;
      }

      // Standard WPX / Pileup / Single / HST: RST + Serial Number
      let res = `${this.rst}${String(this.nr).padStart(3, "0")}`;
      if (this.nrWithError) {
        const chars = res.split("");
        let idx = chars.length - 1;
        if (!/[2-7]/.test(chars[idx]) && idx > 0) idx--;
        if (/[2-7]/.test(chars[idx])) {
          const code = chars[idx].charCodeAt(0) + (Math.random() < 0.5 ? -1 : 1);
          chars[idx] = String.fromCharCode(code);
          res = chars.join("") + `EEEEE ${String(this.nr).padStart(3, "0")}`;
        }
        this.nrWithError = false;
      }

      res = res.replace(/599/g, "5NN");
      if (mode !== "rmHst") {
        res = res.replace(/000/g, "TTT").replace(/00/g, "TT");
        if (Math.random() < 0.4) {
          res = res.replace(/0/g, "O");
        } else if (Math.random() < 0.97) {
          res = res.replace(/0/g, "T");
        }
        if (Math.random() < 0.97) {
          res = res.replace(/9/g, "N");
        }
      }
      return res;
    }

    sendMsg(aMsg) {
      if (!this.envelope) this.msg.clear();
      if (aMsg === "msgNone") {
        this.state = ST.Listening;
        return;
      }
      this.msg.add(aMsg);
      const isSst = this.contest.ini.runMode === "rmSst";

      switch (aMsg) {
        case "msgCQ":
          this.sendText(isSst ? "CQ SST <my>" : "CQ <my> TEST");
          break;
        case "msgNR":
          this.sendText("<#>");
          break;
        case "msgTU": {
          if (isSst) {
            const hName = String(this.hisName || "").trim().toUpperCase();
            this.sendText(hName ? `TU ${hName} 73` : "TU 73");
          } else {
            this.sendText("TU");
          }
          break;
        }
        case "msgMyCall":
          this.sendText("<my>");
          break;
        case "msgHisCall":
          this.sendText("<his>");
          break;
        case "msgB4":
          this.sendText("QSO B4");
          break;
        case "msgQm":
          this.sendText("?");
          break;
        case "msgNil":
          this.sendText("NIL");
          break;
        case "msgR_NR": {
          if (isSst) {
            // Per K1USN SST rules (k1usn.com/sst_rules.html): friendly greetings with runner's name
            const runnerName = String(this.contest.ini.hamName || "").trim().toUpperCase();
            const r = Math.random();
            if (runnerName && r < 0.25) {
              this.sendText(`GM ${runnerName} <#>`);
            } else if (runnerName && r < 0.45) {
              this.sendText(`GA ${runnerName} <#>`);
            } else if (runnerName && r < 0.60) {
              this.sendText(`GE ${runnerName} <#>`);
            } else if (runnerName && r < 0.80) {
              this.sendText(`TU ${runnerName} <#>`);
            } else {
              this.sendText("R <#>");
            }
          } else {
            this.sendText("R <#>");
          }
          break;
        }
        case "msgR_NR2":
          this.sendText("R <#> <#>");
          break;
        case "msgDeMyCall1":
          this.sendText("<my>");
          break;
        case "msgDeMyCall2":
          this.sendText("<my> <my>");
          break;
        case "msgDeMyCallNr1":
          this.sendText("<my> <#>");
          break;
        case "msgDeMyCallNr2":
          this.sendText("<my> <my> <#>");
          break;
        case "msgMyCallNr2":
          this.sendText("<my> <my> <#>");
          break;
        case "msgNrQm":
          this.sendText(isSst ? "AGN?" : "NR?");
          break;
        case "msgLongCQ":
          this.sendText(isSst ? "CQ CQ SST <my> <my> SST" : "CQ CQ TEST <my> <my> TEST");
          break;
        case "msgQrl":
          this.sendText("QRL?");
          break;
        case "msgQrl2":
          this.sendText("QRL?   QRL?");
          break;
        case "msqQsy":
          this.sendText("<his>  QSY QSY");
          break;
        case "msgAgn":
          this.sendText("AGN");
          break;
      }
    }

    sendText(aMsg) {
      let txt = aMsg;
      if (txt.includes("<#>")) {
        txt = txt.replace("<#>", this.nrAsText());
        txt = txt.replace(/<#>/g, this.nrAsText());
      }
      txt = txt.replace(/<my>/g, this.myCall);
      this.msgText = this.msgText ? `${this.msgText} ${txt}` : txt;
      this.sendMorse(this.contest.keyer.encode(this.msgText));
    }

    sendMorse(aMorse) {
      if (!this.envelope) {
        this.sendPos = 0;
        this.bfo = 0;
      }
      this.envelope = this.contest.keyer.makeEnvelope(aMorse, this.wpm, this.amplitude);
      this.state = ST.Sending;
      this.timeOut = NEVER;
    }

    tick() {
      if (this.state === ST.Sending && !this.envelope) {
        this.msgText = "";
        this.state = ST.Listening;
        this.processEvent(EV.MsgSent);
      } else if (this.state !== ST.Sending) {
        if (this.timeOut > -1) this.timeOut--;
        if (this.timeOut === 0) this.processEvent(EV.Timeout);
      }
    }

    processEvent(_event) {}
  }

  // ---------------------------------------------------------------------------
  // TMyStation (MyStn.pas)
  // ---------------------------------------------------------------------------
  class MyStation extends Station {
    constructor(contest) {
      super(contest);
      this.pieces = [];
      this.init();
    }

    init() {
      this.myCall = this.contest.ini.call;
      this.opName = this.contest.ini.hamName || "BOB";
      this.spc = this.contest.ini.mySpc || "IN";
      this.cwtNr = this.contest.ini.myCwt || "1042";
      this.nr = 1;
      this.rst = 599;
      this.pitch = this.contest.ini.pitch;
      this.wpm = this.contest.ini.wpm;
      this.amplitude = 300000;
      this.pieces = [];
      this.envelope = null;
      this.state = ST.Listening;
    }

    nrAsText() {
      const mode = this.contest.ini.runMode;
      if (mode === "rmSst") {
        return `${this.contest.ini.hamName || "BOB"} ${this.contest.ini.mySpc || "IN"}`;
      }
      if (mode === "rmCwt") {
        return `${this.contest.ini.hamName || "BOB"} ${this.contest.ini.myCwt || this.contest.ini.mySpc || "1042"}`;
      }
      return `5NN ${String(this.nr).padStart(3, "0").replace(/0/g, "T").replace(/9/g, "N")}`;
    }

    processEvent(aEvent) {
      if (aEvent === EV.MsgSent) {
        this.contest.onMeFinishedSending();
      }
    }

    abortSend() {
      this.envelope = null;
      this.msg = new Set(["msgGarbage"]);
      this.msgText = "";
      this.pieces = [];
      this.state = ST.Listening;
      this.processEvent(EV.MsgSent);
    }

    sendText(aMsg) {
      this.addToPieces(aMsg);
      if (this.state !== ST.Sending) {
        this.sendNextPiece();
        this.contest.onMeStartedSending();
      }
    }

    addToPieces(aMsg) {
      let rem = aMsg;
      let p = rem.indexOf("<his>");
      while (p >= 0) {
        if (p > 0) this.pieces.push(rem.slice(0, p));
        this.pieces.push("@");
        rem = rem.slice(p + 5);
        p = rem.indexOf("<his>");
      }
      if (rem.length > 0) this.pieces.push(rem);
    }

    sendNextPiece() {
      this.msgText = "";
      if (this.pieces.length === 0) return;
      if (this.pieces[0] !== "@") {
        super.sendText(this.pieces[0]);
      } else {
        super.sendText(this.hisCall);
      }
    }

    getBlock() {
      const res = super.getBlock();
      if (!this.envelope) {
        this.pieces.shift();
        if (this.pieces.length > 0) {
          this.sendNextPiece();
        }
        if (this.contest.onAdvanceCursor) {
          this.contest.onAdvanceCursor();
        }
      }
      return res;
    }

    updateCallInMessage(aCall) {
      const clean = String(aCall || "").trim().toUpperCase();
      if (!clean) return false;

      if (this.pieces.length > 0 && this.pieces[0] === "@" && this.envelope) {
        const morse = this.contest.keyer.encode(clean);
        const newEnv = this.contest.keyer.makeEnvelope(morse, this.wpm, this.amplitude);
        if (newEnv.length >= this.sendPos) {
          let matches = true;
          for (let i = 0; i < this.sendPos; i++) {
            if (Math.abs(this.envelope[i] - newEnv[i]) > 1e-2) {
              matches = false;
              break;
            }
          }
          if (matches) {
            this.envelope = newEnv;
            this.hisCall = clean;
            return true;
          }
        }
      }

      for (let i = 1; i < this.pieces.length; i++) {
        if (this.pieces[i] === "@") {
          this.hisCall = clean;
          return true;
        }
      }
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // TDxOperator (DxOper.pas) — Dynamic Programming Callsign Matcher & AI
  // ---------------------------------------------------------------------------
  class DxOperator {
    constructor(contest, call, skills) {
      this.contest = contest;
      this.call = call;
      this.skills = skills; // 1..3
      this.patience = FULL_PATIENCE;
      this.repeatCnt = 1;
      this.state = OS.NeedPrevEnd;
    }

    getSendDelay() {
      if (this.state === OS.NeedPrevEnd) return NEVER;
      if (this.contest.ini.runMode === "rmHst") {
        return secondsToBlocks(0.05 + (0.5 * Math.random() * 10) / this.contest.ini.wpm);
      }
      return secondsToBlocks(0.1 + 0.5 * Math.random());
    }

    getWpm() {
      const ini = this.contest.ini;
      if (ini.runMode === "rmHst") return ini.wpm;
      if (ini.runMode === "rmSst") {
        // K1USN SST official rules (k1usn.com/sst_rules.html): strict 20 WPM maximum speed limit
        const maxSst = Math.max(13, Math.min(20, ini.wpm));
        const minSst = Math.max(12, Math.round(maxSst * 0.68));
        return Math.round(minSst + Math.random() * (maxSst - minSst));
      }
      return Math.round(ini.wpm * 0.5 * (1 + Math.random()));
    }

    getNR() {
      return 1 + Math.round(Math.random() * this.contest.minute() * this.skills);
    }

    getReplyTimeout() {
      const ini = this.contest.ini;
      let res =
        ini.runMode === "rmHst"
          ? secondsToBlocks(60 / ini.wpm)
          : secondsToBlocks(6 - this.skills);
      return Math.max(4, Math.round(rndGaussLim(res, res / 2)));
    }

    decPatience() {
      if (this.state === OS.Done) return;
      this.patience--;
      if (this.patience < 1) this.state = OS.Failed;
    }

    setState(aState) {
      this.state = aState;
      this.patience = aState === OS.NeedQso ? Math.max(1, Math.round(rndRayleigh(4))) : FULL_PATIENCE;
      const mode = this.contest.ini.runMode;
      if (aState === OS.NeedQso && mode !== "rmSingle" && mode !== "rmHst" && Math.random() < 0.1) {
        this.repeatCnt = 2;
      } else {
        this.repeatCnt = 1;
      }
    }

    // Dynamic programming edit-distance & wildcard matcher (DxOper.pas + N1MM partial call rules)
    isMyCall() {
      const W_X = 2;
      const W_Y = 2;
      const W_D = 2;
      const c0 = this.call;
      const c = String(this.contest.me.hisCall || "").toUpperCase().trim();
      if (!c) return "mcNo";

      // If operator sent a partial/wildcard query with '?' (e.g. "WR?", "W4?", "?9A"):
      // Match any calling station whose callsign contains all known characters in order.
      if (c.includes("?")) {
        const known = c.replace(/\?/g, "");
        if (known.length === 0) return "mcNo";
        let i = 0;
        for (let j = 0; j < c0.length && i < known.length; j++) {
          if (c0[j] === known[i]) i++;
        }
        return i === known.length ? "mcAlmost" : "mcNo";
      }

      const rows = c.length + 1;
      const cols = c0.length + 1;
      const M = Array.from({ length: rows }, () => new Int32Array(cols));

      for (let y = 0; y < cols; y++) M[0][y] = 0;
      for (let x = 1; x < rows; x++) M[x][0] = M[x - 1][0] + W_X;

      for (let x = 1; x < rows; x++) {
        for (let y = 1; y < cols; y++) {
          let t = M[x][y - 1];
          if (x < rows - 1) t += W_Y;

          const l = M[x - 1][y] + W_X;

          let d = M[x - 1][y - 1];
          if (c[x - 1] !== c0[y - 1]) d += W_D;

          M[x][y] = Math.min(t, d, l);
        }
      }

      const penalty = M[rows - 1][cols - 1];
      let res = "mcNo";
      if (penalty === 0) {
        res = "mcYes";
      } else if (penalty === 1 || penalty === 2) {
        res = "mcAlmost";
      }

      if (!this.contest.ini.lids && c.length === 2 && res === "mcAlmost") {
        res = "mcNo";
      }
      if (res === "mcYes" && c.length !== c0.length) {
        res = "mcAlmost";
      }
      if (c.length < 2) {
        res = "mcNo";
      }
      if (this.contest.ini.lids && c.length > 3) {
        if (res === "mcYes" && Math.random() < 0.01) res = "mcAlmost";
        else if (res === "mcAlmost" && Math.random() < 0.04) res = "mcYes";
      }
      return res;
    }

    msgReceived(aMsg) {
      if (aMsg.has("msgCQ")) {
        switch (this.state) {
          case OS.NeedPrevEnd:
            this.setState(OS.NeedQso);
            break;
          case OS.NeedQso:
            this.decPatience();
            break;
          case OS.NeedNr:
          case OS.NeedCall:
          case OS.NeedCallNr:
            this.state = OS.Failed;
            break;
          case OS.NeedEnd:
            this.state = OS.Done;
            break;
        }
        return;
      }

      if (aMsg.has("msgNil")) {
        switch (this.state) {
          case OS.NeedPrevEnd:
            this.setState(OS.NeedQso);
            break;
          case OS.NeedQso:
            this.decPatience();
            break;
          case OS.NeedNr:
          case OS.NeedCall:
          case OS.NeedCallNr:
          case OS.NeedEnd:
            this.state = OS.Failed;
            break;
        }
        return;
      }

      if (aMsg.has("msgQm") && !aMsg.has("msgHisCall") && !aMsg.has("msgNR")) {
        if (this.state === OS.NeedPrevEnd) {
          this.setState(OS.NeedQso);
        }
      }

      if (aMsg.has("msgHisCall")) {
        const match = this.isMyCall();
        if (match === "mcYes") {
          if (this.state === OS.NeedPrevEnd || this.state === OS.NeedQso) {
            this.setState(OS.NeedNr);
          } else if (this.state === OS.NeedCallNr) {
            this.setState(OS.NeedNr);
          } else if (this.state === OS.NeedCall) {
            this.setState(OS.NeedEnd);
          }
        } else if (match === "mcAlmost") {
          if (this.state === OS.NeedPrevEnd || this.state === OS.NeedQso) {
            this.setState(OS.NeedCallNr);
          } else if (this.state === OS.NeedNr) {
            this.setState(OS.NeedCallNr);
          } else if (this.state === OS.NeedEnd) {
            this.setState(OS.NeedCall);
          }
        } else {
          if (this.state === OS.NeedQso) {
            this.state = OS.NeedPrevEnd;
          } else if (
            this.state === OS.NeedNr ||
            this.state === OS.NeedCall ||
            this.state === OS.NeedCallNr
          ) {
            this.state = OS.Failed;
          } else if (this.state === OS.NeedEnd) {
            this.state = OS.Done;
          }
        }
      }

      if (aMsg.has("msgB4")) {
        if (this.state === OS.NeedPrevEnd || this.state === OS.NeedQso) {
          this.setState(OS.NeedQso);
        } else if (this.state === OS.NeedNr || this.state === OS.NeedEnd) {
          this.state = OS.Failed;
        }
      }

      if (aMsg.has("msgNR")) {
        if (this.state === OS.NeedQso) {
          this.state = OS.NeedPrevEnd;
        } else if (this.state === OS.NeedNr) {
          if (Math.random() < 0.9 || this.contest.ini.runMode === "rmHst") {
            this.setState(OS.NeedEnd);
          }
        } else if (this.state === OS.NeedCallNr) {
          if (Math.random() < 0.9 || this.contest.ini.runMode === "rmHst") {
            this.setState(OS.NeedCall);
          }
        }
      }

      if (aMsg.has("msgTU")) {
        if (this.state === OS.NeedPrevEnd) {
          this.setState(OS.NeedQso);
        } else if (this.state === OS.NeedEnd) {
          this.state = OS.Done;
        }
      }

      if (!this.contest.ini.lids && aMsg.size === 1 && aMsg.has("msgGarbage")) {
        this.state = OS.NeedPrevEnd;
      }

      if (this.state !== OS.NeedPrevEnd) {
        this.decPatience();
      }
    }

    getReply() {
      const isHst = this.contest.ini.runMode === "rmHst";
      switch (this.state) {
        case OS.NeedPrevEnd:
        case OS.Done:
        case OS.Failed:
          return "msgNone";
        case OS.NeedQso:
          return "msgMyCall";
        case OS.NeedNr:
          return this.patience === FULL_PATIENCE - 1 || Math.random() < 0.3
            ? "msgNrQm"
            : "msgAgn";
        case OS.NeedCall:
          if (isHst || Math.random() > 0.5) return "msgDeMyCallNr1";
          return Math.random() > 0.25 ? "msgDeMyCallNr2" : "msgMyCallNr2";
        case OS.NeedCallNr:
          return isHst || Math.random() > 0.5 ? "msgDeMyCall1" : "msgDeMyCall2";
        default:
          // osNeedEnd
          if (this.patience < FULL_PATIENCE - 1) return "msgNR";
          return isHst || Math.random() < 0.9 ? "msgR_NR" : "msgR_NR2";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TDxStation (DxStn.pas)
  // ---------------------------------------------------------------------------
  class DxStation extends Station {
    constructor(contest) {
      super(contest);
      this.hisCall = contest.ini.call;
      const picked = contest.pickStation();
      this.myCall = picked.call;
      this.opName = picked.name;
      this.spc = picked.spc;
      this.cwtNr = picked.cwt;

      const skills = 1 + Math.floor(Math.random() * 3);
      this.oper = new DxOperator(contest, this.myCall, skills);
      this.oper.setState(OS.NeedPrevEnd);
      this.nrWithError = contest.ini.lids && Math.random() < 0.28;
      this.wpm = this.oper.getWpm();
      this.nr = this.oper.getNR();
      this.rst =
        contest.ini.lids && Math.random() < 0.08
          ? 559 + 10 * Math.floor(Math.random() * 4)
          : 599;

      this.isFlutterStation = Math.random() < 0.65;
      this.slowQsbBw = 0.15 + Math.random() * 0.55;
      this.flutterQsbBw = 8.0 + Math.random() * 22.0;
      const initialBw =
        contest.ini.flutter && this.isFlutterStation ? this.flutterQsbBw : this.slowQsbBw;
      this.qsb = new Qsb(initialBw, contest.ini.bufSize);
      this.amplitude = 9000 + 18000 * (1 + rndUShaped());
      this.pitch = Math.round(rndGaussLim(0, 300));
      this.timeOut = NEVER;
      this.state = ST.Copying;
      this.markedForDelete = false;
    }

    syncBandConditions() {
      const wantFlutter = this.contest.ini.flutter && this.isFlutterStation;
      const targetBw = wantFlutter ? this.flutterQsbBw : this.slowQsbBw;
      if (Math.abs(this.qsb.bandwidth - targetBw) > 0.01) {
        this.qsb.setBandwidth(targetBw);
      }
      this.nrWithError = this.contest.ini.lids && Math.random() < 0.28;
    }

    processEvent(aEvent) {
      if (this.oper.state === OS.Done) return;
      switch (aEvent) {
        case EV.MsgSent:
          if (this.contest.me.state === ST.Sending) {
            this.timeOut = NEVER;
          } else {
            this.timeOut = this.oper.getReplyTimeout();
          }
          break;

        case EV.Timeout:
          if (this.state === ST.Listening) {
            this.oper.msgReceived(new Set(["msgNone"]));
            if (this.oper.state === OS.Failed) {
              this.markedForDelete = true;
              return;
            }
            this.state = ST.PreparingToSend;
          }
          if (this.state === ST.PreparingToSend) {
            for (let i = 0; i < this.oper.repeatCnt; i++) {
              this.sendMsg(this.oper.getReply());
            }
          }
          break;

        case EV.MeFinished:
          if (this.state !== ST.Sending) {
            if (this.state === ST.Copying) {
              this.oper.msgReceived(this.contest.me.msg);
            } else if (
              this.state === ST.Listening ||
              this.state === ST.PreparingToSend
            ) {
              if (
                this.contest.me.msg.has("msgCQ") ||
                this.contest.me.msg.has("msgTU") ||
                this.contest.me.msg.has("msgNil")
              ) {
                this.oper.msgReceived(this.contest.me.msg);
              } else {
                this.oper.msgReceived(new Set(["msgGarbage"]));
              }
            }

            if (this.oper.state === OS.Failed) {
              this.markedForDelete = true;
              return;
            }
            this.timeOut = this.oper.getSendDelay();
            this.state = ST.PreparingToSend;
          }
          break;

        case EV.MeStarted:
          if (this.state !== ST.Sending) {
            this.state = ST.Copying;
          }
          this.timeOut = NEVER;
          break;
      }
    }

    getBfo() {
      let res = this.bfo;
      if (this.contest.ini.flutter && this.isFlutterStation) {
        // Auroral Doppler phase dispersion (raspy polar flutter tone)
        res += 0.35 * (Math.random() - 0.5);
      }
      this.bfo += this.dPhi;
      if (this.bfo > TWO_PI) this.bfo -= TWO_PI;
      return res;
    }

    getBlock() {
      const res = super.getBlock();
      const useFlutter = this.contest.ini.flutter && this.isFlutterStation;
      const useQsb = this.contest.ini.qsb;
      if (useQsb || useFlutter) {
        const targetBw = useFlutter ? this.flutterQsbBw : this.slowQsbBw;
        if (Math.abs(this.qsb.bandwidth - targetBw) > 0.01) {
          this.qsb.setBandwidth(targetBw);
        }
        this.qsb.applyTo(res);
      }
      return res;
    }
  }

  // ---------------------------------------------------------------------------
  // TQrmStation (QrmStn.pas)
  // ---------------------------------------------------------------------------
  class QrmStation extends Station {
    constructor(contest) {
      super(contest);
      this.patience = 1 + Math.floor(Math.random() * 5);
      const picked = contest.pickStation();
      this.myCall = picked.call;
      this.hisCall = contest.ini.call;
      this.amplitude = 5000 + 25000 * Math.random();
      this.pitch = Math.round(rndGaussLim(0, 300));
      this.wpm = 30 + Math.floor(Math.random() * 20);
      this.markedForDelete = false;

      const r = Math.floor(Math.random() * 7);
      if (r === 0) this.sendMsg("msgQrl");
      else if (r === 1 || r === 2) this.sendMsg("msgQrl2");
      else if (r <= 5) this.sendMsg("msgLongCQ");
      else this.sendMsg("msqQsy");
    }

    processEvent(aEvent) {
      if (aEvent === EV.MsgSent) {
        this.patience--;
        if (this.patience <= 0) {
          this.markedForDelete = true;
        } else {
          this.timeOut = Math.max(2, Math.round(rndGaussLim(secondsToBlocks(4), 2)));
        }
      } else if (aEvent === EV.Timeout) {
        this.sendMsg("msgLongCQ");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TQrnStation (QrnStn.pas) — Atmospheric Static Crash Burst
  // ---------------------------------------------------------------------------
  class QrnStation extends Station {
    constructor(contest) {
      super(contest);
      const blocks = Math.max(1, secondsToBlocks(Math.random(), contest.ini.bufSize));
      const dur = blocks * contest.ini.bufSize;
      this.envelope = new Float32Array(dur);
      this.amplitude = 1e5 * Math.pow(10, 2 * Math.random());

      if (contest.ini.qrnModel === "middleton") {
        // Middleton Class B / Pareto heavy-tailed sferic burst with waveguide ringing
        const alpha = 1.35;
        for (let i = 0; i < dur; i++) {
          if (Math.random() < 0.014) {
            const u = 0.001 + 0.998 * Math.random();
            const pareto = Math.min(25.0, Math.pow(1.0 - u, -1.0 / alpha) - 1.0);
            const sign = Math.random() < 0.5 ? -1 : 1;
            const pulse = sign * pareto * this.amplitude * 0.22;
            // Short damped waveguide ring (~3ms)
            const ringLen = Math.min(36, dur - i);
            for (let k = 0; k < ringLen; k++) {
              this.envelope[i + k] +=
                pulse * Math.exp(-k / 10.0) * Math.cos(0.45 * k);
            }
          }
        }
      } else {
        // Original VE3NEA QrnStn.pas
        for (let i = 0; i < dur; i++) {
          if (Math.random() < 0.01) {
            this.envelope[i] = (Math.random() - 0.5) * this.amplitude;
          }
        }
      }
      this.state = ST.Sending;
      this.markedForDelete = false;
    }

    processEvent(aEvent) {
      if (aEvent === EV.MsgSent) {
        this.markedForDelete = true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Main TContest Coordinator (Contest.pas + Log.pas)
  // ---------------------------------------------------------------------------
  class Contest {
    constructor() {
      this.ini = {
        call: "N9FZ",
        hamName: "BOB",
        mySpc: "IN",
        myCwt: "2104",
        wpm: 20,
        bandWidth: 500,
        pitch: 600,
        qsk: true,
        rit: 0,
        bufSize: DEFAULTBUFSIZE,
        activity: 3,
        qrn: true,
        qrnModel: "middleton", // "middleton" or "ve3nea"
        qrm: true,
        qsb: true,
        flutter: true,
        lids: true,
        duration: 30,
        runMode: "rmStop",
        monVolumeDb: -6,
      };

      this.roster = DEFAULT_ROSTER.map(([call, name, spc, cwt]) => ({
        call,
        name,
        spc,
        cwt,
      }));
      this.availablePool = [];

      this.keyer = new MorseKeyer(DEFAULTRATE, this.ini.bufSize);
      this.me = new MyStation(this);
      this.stations = [];

      const pts = Math.round((0.7 * DEFAULTRATE) / this.ini.bandWidth);
      const gainDb = 10 * Math.log10(500 / this.ini.bandWidth);
      this.filt = new MovingAverage(pts, 3, this.ini.bufSize, gainDb);
      this.filt2 = new MovingAverage(pts, 3, this.ini.bufSize, gainDb);
      this.modul = new Modulator(DEFAULTRATE, this.ini.pitch);
      this.agc = new VolumeControl(155, 155);

      this.blockNumber = 0;
      this.ritPhase = 0.0;
      this.qsoList = [];
      this.callSent = false;
      this.nrSent = false;

      // Callbacks for UI updates
      this.onQsoUpdated = null;
      this.onContestEnded = null;
      this.onAdvanceCursor = null;
      this.onTickStatus = null;
    }

    loadCustomRoster(entries) {
      if (Array.isArray(entries) && entries.length > 0) {
        this.roster = entries;
        this.resetPool();
      }
    }

    resetPool() {
      this.availablePool = this.roster.slice();
    }

    pickStation() {
      if (this.availablePool.length === 0) {
        this.resetPool();
      }
      const idx = Math.floor(Math.random() * this.availablePool.length);
      const picked = this.availablePool[idx];
      if (this.ini.runMode === "rmHst") {
        this.availablePool.splice(idx, 1);
      }
      return picked;
    }

    setBandwidth(bwHz) {
      this.ini.bandWidth = Math.max(100, Math.min(900, bwHz));
      const pts = Math.max(1, Math.round((0.7 * DEFAULTRATE) / this.ini.bandWidth));
      const gainDb = 10 * Math.log10(500 / this.ini.bandWidth);
      this.filt.configure(pts, gainDb);
      this.filt2.configure(pts, gainDb);
    }

    setPitch(pitchHz) {
      this.ini.pitch = Math.max(300, Math.min(900, pitchHz));
      this.modul.setCarrierFreq(this.ini.pitch);
      this.me.pitch = this.ini.pitch;
    }

    setWpm(wpm) {
      this.ini.wpm = Math.max(10, Math.min(80, wpm));
      this.me.wpm = this.ini.wpm;
    }

    initRun(mode) {
      this.ini.runMode = mode;
      this.blockNumber = 0;
      this.ritPhase = 0;
      this.stations = [];
      this.qsoList = [];
      this.callSent = false;
      this.nrSent = false;
      this.resetPool();
      this.me.init();
      this.filt.reset();
      this.filt2.reset();
      this.agc.reset();
    }

    minute() {
      return blocksToSeconds(this.blockNumber, this.ini.bufSize) / 60.0;
    }

    dxCount() {
      let cnt = 0;
      for (const s of this.stations) {
        if (s instanceof DxStation && s.oper.state !== OS.Done && !s.markedForDelete) {
          cnt++;
        }
      }
      return cnt;
    }

    activeDxStations() {
      return this.stations
        .filter((s) => (s instanceof DxStation || s instanceof QrmStation) && !s.markedForDelete)
        .map((s) => ({
          call: s.myCall,
          pitchOffset: s.pitch,
          wpm: s.wpm,
          state: s.state,
          isQrm: s instanceof QrmStation,
          operState: s instanceof DxStation ? s.oper.state : "qrm",
        }));
    }

    updateBandConditions(prevFlags = {}) {
      for (let i = this.stations.length - 1; i >= 0; i--) {
        const s = this.stations[i];
        if (!this.ini.qrn && s instanceof QrnStation) {
          this.stations.splice(i, 1);
        } else if (!this.ini.qrm && s instanceof QrmStation) {
          this.stations.splice(i, 1);
        } else if (s instanceof DxStation) {
          s.syncBandConditions();
        }
      }
      // If user just turned QRM on during a running session and none is active, spawn one immediately
      if (
        this.ini.runMode !== "rmStop" &&
        this.ini.qrm &&
        prevFlags.qrm === false &&
        !this.stations.some((s) => s instanceof QrmStation)
      ) {
        this.stations.push(new QrmStation(this));
      }
    }

    swapFilters() {
      const tmp = this.filt;
      this.filt = this.filt2;
      this.filt2 = tmp;
      this.filt2.reset();
    }

    onMeStartedSending() {
      for (let i = this.stations.length - 1; i >= 0; i--) {
        this.stations[i].processEvent(EV.MeStarted);
      }
    }

    onMeFinishedSending() {
      const mode = this.ini.runMode;
      if (mode !== "rmSingle" && mode !== "rmHst") {
        const sentCq = this.me.msg.has("msgCQ");
        const sentTuAndMy =
          this.qsoList.length > 0 &&
          this.me.msg.has("msgTU") &&
          this.me.msg.has("msgMyCall");
        if (sentCq || sentTuAndMy) {
          const callersToSpawn = rndPoisson(this.ini.activity / 2.0);
          for (let i = 0; i < callersToSpawn; i++) {
            this.stations.push(new DxStation(this));
          }
        }
      }

      for (let i = this.stations.length - 1; i >= 0; i--) {
        this.stations[i].processEvent(EV.MeFinished);
      }
    }

    // Generate next 512-sample audio block at 11,025 Hz
    getAudio() {
      const bufSize = this.ini.bufSize;
      const NOISEAMP = 6000.0;
      this.blockNumber++;

      const reIm = {
        re: new Float32Array(bufSize),
        im: new Float32Array(bufSize),
      };

      // 1. Complex thermal receiver noise
      for (let i = 0; i < bufSize; i++) {
        reIm.re[i] = 3.0 * NOISEAMP * (Math.random() - 0.5);
        reIm.im[i] = 3.0 * NOISEAMP * (Math.random() - 0.5);
      }

      // 2. QRN (Atmospheric static)
      if (this.ini.qrn) {
        if (this.ini.qrnModel === "middleton") {
          const paretoAlpha = 1.4;
          for (let i = 0; i < bufSize; i++) {
            if (Math.random() < 0.008) {
              const u = 0.002 + 0.996 * Math.random();
              const amp = Math.min(20.0, Math.pow(1.0 - u, -1.0 / paretoAlpha) - 1.0);
              reIm.re[i] += (Math.random() < 0.5 ? -1 : 1) * 28.0 * NOISEAMP * amp;
            }
          }
        } else {
          for (let i = 0; i < bufSize; i++) {
            if (Math.random() < 0.01) {
              reIm.re[i] = 60.0 * NOISEAMP * (Math.random() - 0.5);
            }
          }
        }
        if (Math.random() < 0.01) {
          this.stations.push(new QrnStation(this));
        }
      }

      // 3. QRM (Random interferers — ~every 25s when enabled)
      if (this.ini.qrm && Math.random() < 0.0018) {
        this.stations.push(new QrmStation(this));
      }

      // 4. Mix calling stations in I/Q baseband with RIT offset
      for (let sIdx = 0; sIdx < this.stations.length; sIdx++) {
        const stn = this.stations[sIdx];
        if (stn.state === ST.Sending && !stn.markedForDelete) {
          const blk = stn.getBlock();
          for (let i = 0; i < bufSize; i++) {
            const bfo =
              stn.getBfo() -
              this.ritPhase -
              (i * TWO_PI * this.ini.rit) / DEFAULTRATE;
            reIm.re[i] += blk[i] * Math.cos(bfo);
            reIm.im[i] -= blk[i] * Math.sin(bfo);
          }
        }
      }

      // Advance RIT phase
      this.ritPhase += (bufSize * TWO_PI * this.ini.rit) / DEFAULTRATE;
      while (this.ritPhase > TWO_PI) this.ritPhase -= TWO_PI;
      while (this.ritPhase < -TWO_PI) this.ritPhase += TWO_PI;

      // 5. My transmitted sidetone & QSK break-in attenuation
      let mySidetoneBlk = null;
      if (this.me.state === ST.Sending) {
        mySidetoneBlk = this.me.getBlock();
        let rfg = 1.0;
        for (let i = 0; i < bufSize; i++) {
          if (this.ini.qsk) {
            const targetRfg = Math.max(0.0, 1.0 - mySidetoneBlk[i] / this.me.amplitude);
            if (rfg > targetRfg) rfg = targetRfg;
            else rfg = rfg * 0.992 + 0.008;
            reIm.re[i] *= rfg;
            reIm.im[i] *= rfg;
          } else {
            reIm.re[i] = 0.0;
            reIm.im[i] = 0.0;
          }
        }
      }

      // 6. Dual-buffer complex baseband IF filter
      this.filt2.filterReIm(reIm);
      const filteredReIm = this.filt.filterReIm(reIm);
      if (this.blockNumber % 10 === 0) {
        this.swapFilters();
      }

      // 7. Up-convert to audio Pitch and run Receiver AGC
      const modulated = this.modul.modulate(filteredReIm);
      const agcOut = this.agc.process(modulated);

      // Mix local CW Sidetone post-AGC so Sidetone Level (dB) controls volume directly
      if (mySidetoneBlk) {
        const sidetoneGain =
          this.ini.monVolumeDb <= -30
            ? 0.0
            : Math.pow(10, this.ini.monVolumeDb / 20.0);
        const maxTone = 18000.0 * sidetoneGain;
        for (let i = 0; i < bufSize; i++) {
          const envNorm = mySidetoneBlk[i] / this.me.amplitude;
          const tone = envNorm * maxTone * Math.sin(this.me.getBfo());
          agcOut[i] = Math.max(-32000, Math.min(32000, agcOut[i] + tone));
        }
      }

      // 8. Tick station state machines
      this.me.tick();
      for (let i = this.stations.length - 1; i >= 0; i--) {
        this.stations[i].tick();
      }

      // 9. Verify completed QSOs when DX station transitions to osDone
      for (let i = this.stations.length - 1; i >= 0; i--) {
        const s = this.stations[i];
        if (s instanceof DxStation && s.oper.state === OS.Done) {
          if (this.qsoList.length > 0) {
            const lastQso = this.qsoList[this.qsoList.length - 1];
            if (lastQso.call === s.myCall && !lastQso.verified) {
              this.applyDxVerification(lastQso, s);
              s.markedForDelete = true;
              if (this.onQsoUpdated) this.onQsoUpdated();
            }
          }
        }
        if (s.markedForDelete) {
          this.stations.splice(i, 1);
        }
      }

      // 10. Single Calls & HST auto-caller spawning
      if (this.ini.runMode === "rmSingle" && this.dxCount() === 0) {
        this.me.msg = new Set(["msgCQ"]);
        const caller = new DxStation(this);
        this.stations.push(caller);
        caller.processEvent(EV.MeFinished);
      } else if (this.ini.runMode === "rmHst" && this.dxCount() < this.ini.activity) {
        this.me.msg = new Set(["msgCQ"]);
        const needed = this.ini.activity - this.dxCount();
        for (let i = 0; i < needed; i++) {
          const caller = new DxStation(this);
          this.stations.push(caller);
          caller.processEvent(EV.MeFinished);
        }
      }

      // 11. Check session timer expiration
      const elapsedSec = blocksToSeconds(this.blockNumber, bufSize);
      if (elapsedSec >= this.ini.duration * 60) {
        if (this.onContestEnded) this.onContestEnded();
        else this.ini.runMode = "rmStop";
      } else if (this.onTickStatus && this.blockNumber % 5 === 0) {
        this.onTickStatus(elapsedSec);
      }

      return agcOut;
    }

    applyDxVerification(qso, dxStation) {
      qso.trueCall = dxStation.myCall;
      qso.trueRst = String(dxStation.rst);
      qso.trueNr = String(dxStation.nr);
      qso.trueName = dxStation.opName;
      qso.trueSpc = dxStation.spc;
      qso.trueCwt = dxStation.cwtNr;
      qso.verified = true;
      this.checkErr(qso);
    }

    checkErr(qso) {
      if (!qso.trueCall) {
        qso.err = "NIL";
        return;
      }
      if (qso.dupe) {
        qso.err = "DUP";
        return;
      }
      const mode = this.ini.runMode;
      if (mode === "rmSst") {
        const dxcc = extractDxccPrefix(qso.trueCall || qso.call);
        const validSpc =
          qso.recv2 === qso.trueSpc ||
          (!isUsOrCanadaCall(qso.trueCall || qso.call) &&
            (qso.recv2 === "DX" || qso.recv2 === dxcc));
        if (qso.recv1 !== qso.trueName) qso.err = "NAM";
        else if (!validSpc) qso.err = "SPC";
        else qso.err = "   ";
      } else if (mode === "rmCwt") {
        if (qso.recv1 !== qso.trueName) qso.err = "NAM";
        else if (qso.recv2 !== qso.trueCwt && qso.recv2 !== qso.trueSpc) qso.err = "EX ";
        else qso.err = "   ";
      } else {
        if (Number(qso.recv1) !== Number(qso.trueRst)) qso.err = "RST";
        else if (Number(qso.recv2) !== Number(qso.trueNr)) qso.err = "NR ";
        else qso.err = "   ";
      }
    }

    saveQso(callInput, exch1Input, exch2Input) {
      const cleanCall = String(callInput || "")
        .toUpperCase()
        .replace(/\?/g, "")
        .trim();
      const recv1 = String(exch1Input || "").toUpperCase().trim();
      const recv2 = String(exch2Input || "").toUpperCase().trim();

      if (cleanCall.length < 3 || !recv1 || !recv2) {
        return false;
      }

      const elapsedSec = blocksToSeconds(this.blockNumber, this.ini.bufSize);
      const mins = Math.floor(elapsedSec / 60);
      const secs = Math.floor(elapsedSec % 60);
      const hrs = Math.floor(mins / 60);
      const timeStr = `${String(hrs).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
      const utcCompact = `${String(hrs).padStart(2, "0")}${String(mins % 60).padStart(2, "0")}`;

      const mode = this.ini.runMode;
      let mult = "";
      if (mode === "rmSst") {
        // K1USNSST.udc: Multiplier1 = Sect (48SDC14P + AK/HI), Multiplier2 = CountryPrefix (DXc, excluding K & VE)
        mult =
          !isUsOrCanadaCall(cleanCall) && recv2 === "DX"
            ? extractDxccPrefix(cleanCall)
            : recv2;
      } else if (mode === "rmCwt") {
        mult = cleanCall;
      } else if (mode === "rmHst") {
        mult = String(callToScore(cleanCall, this.keyer));
      } else {
        mult = extractPrefix(cleanCall);
      }

      const sent1 =
        mode === "rmSst" || mode === "rmCwt"
          ? this.ini.hamName || "BOB"
          : "599";
      const sent2 =
        mode === "rmSst"
          ? this.ini.mySpc || "IN"
          : mode === "rmCwt"
          ? this.ini.myCwt || "1042"
          : String(this.me.nr).padStart(3, "0");

      const dupe = this.qsoList.some(
        (prev) => prev.call === cleanCall && prev.err === "   "
      );

      const qso = {
        idx: this.qsoList.length + 1,
        tSec: elapsedSec,
        timeStr,
        utc: utcCompact,
        call: cleanCall,
        recv1,
        recv2,
        sent1,
        sent2,
        pfx: mult,
        dupe,
        verified: false,
        trueCall: "",
        err: "NIL",
      };

      // Check if a DX station is already in osDone for this call
      for (let i = this.stations.length - 1; i >= 0; i--) {
        const s = this.stations[i];
        if (s instanceof DxStation && s.oper.state === OS.Done && s.myCall === cleanCall) {
          this.applyDxVerification(qso, s);
          this.stations.splice(i, 1);
          break;
        }
      }

      if (!qso.verified) {
        this.checkErr(qso);
      }

      this.qsoList.push(qso);
      this.me.nr++;
      this.callSent = false;
      this.nrSent = false;

      if (this.onQsoUpdated) this.onQsoUpdated();
      return true;
    }

    computeStats() {
      const mode = this.ini.runMode;
      if (mode === "rmHst") {
        let rawScore = 0;
        let validScore = 0;
        for (const q of this.qsoList) {
          const pts = callToScore(q.call, this.keyer);
          rawScore += pts;
          if (q.err === "   ") validScore += pts;
        }
        return {
          rawQsos: this.qsoList.length,
          validQsos: this.qsoList.filter((q) => q.err === "   ").length,
          rawMults: 1,
          validMults: 1,
          rawScore,
          validScore,
        };
      }

      const rawMultSet = new Set();
      const validMultSet = new Set();
      let validQsos = 0;

      for (const q of this.qsoList) {
        if (q.pfx) rawMultSet.add(q.pfx);
        if (q.err === "   ") {
          validQsos++;
          if (q.pfx) validMultSet.add(q.pfx);
        }
      }

      const rawQsos = this.qsoList.length;
      const rawMults = rawMultSet.size;
      const validMults = validMultSet.size;

      return {
        rawQsos,
        validQsos,
        rawMults,
        validMults,
        rawScore: rawQsos * Math.max(1, rawMults),
        validScore: validQsos * Math.max(1, validMults),
      };
    }

    computeRate() {
      const elapsedSec = blocksToSeconds(this.blockNumber, this.ini.bufSize);
      if (elapsedSec < 5) return 0;
      const windowSec = Math.min(300, elapsedSec);
      const cutoff = elapsedSec - windowSec;
      let cnt = 0;
      for (let i = this.qsoList.length - 1; i >= 0; i--) {
        if (this.qsoList[i].tSec >= cutoff) cnt++;
        else break;
      }
      return Math.round((cnt / windowSec) * 3600);
    }
  }

  return {
    OS,
    ST,
    EV,
    DEFAULT_ROSTER,
    extractPrefix,
    callToScore,
    Contest,
  };
})();
