# pyMorseRunner (Container & WebAudio Edition)

A cross-platform Python + WebAudio port of Alex Shovkoplyas's (**VE3NEA**) classic **Morse Runner 1.68** CW Contest Simulator (MPL-2.0), enhanced with:

- **K1USN Slow Speed Test (SST) Mode**: Practices the exact `Name + State/Province/DX` exchange at speeds capped around $\le 20\text{ WPM}$.
- **CWops CWT Mode**: Practices `Name + Member# / SPC` exchanges.
- **Classic CQ WPX / Pile-Up / Single Calls / IARU HST Modes**: Faithful port of the original Delphi DSP and state-machine units.
- **Middleton Class B / Pareto Sferic QRN Synthesis**: Choose between the classic VE3NEA static burst model or the physical Middleton Class B waveguide sferic model.
- **N1MM Logger+ / Morse Runner Keyboard Muscle Memory**: Full **ESM (Enter Sends Messages)** state machine, `F1`–`F8` macros, `Space` field jumping, live callsign update while sending, RIT (`Up`/`Down`), and Cabrillo (`.log`) / ADIF (`.adi`) log export for macOS loggers (SkookumLogger, RUMlogNG).

---

This software is alpha and untested.

## TODO

- Test contest adherence to rules.

  -[ ] SST
  -[ ] others...

- Add POTA CW session 
- Fix AUTH  


## Quick Start (Docker Container)

```bash
cd /Users/a220018178/Documents/antigravity/coding/morse-runner
docker compose up -d --build
```

Then open **http://localhost:8073** in Safari, Chrome, or Firefox.

### Running Directly Without Docker

```bash
python3 app.py
```

---

## Keyboard Shortcuts (N1MM / Morse Runner Compatible)

| Key | Action |
| :--- | :--- |
| `Enter` | **ESM (Enter Sends Messages)**: Sends `CQ` when Call is empty $\rightarrow$ Sends `<His> <Exch>` when Call is entered $\rightarrow$ Sends `TU` & logs QSO when Exchange is filled |
| `Space` | Jump between `Callsign` and `Exchange` fields (typing `NAME SPC` with a space in the Name box automatically splits Name and State!) |
| `F1` – `F8` | `F1` CQ, `F2` Exchange, `F3` TU, `F4` `<my>`, `F5` `<his>`, `F6` QSO B4, `F7` `?`, `F8` NIL |
| `;` or `Insert` | Send `<his>` + `<Exchange>` (`F5` + `F2`) |
| `.` or `+` or `,` | Send `TU` + Save QSO (`F3` + Log) |
| `Esc` | Immediately abort CW transmission |
| `Alt+W` / `Ctrl+W` / `F11` | Wipe entry fields |
| `Up` / `Down` | Adjust RIT ($\pm 50\text{ Hz}$) |
| `Ctrl+Up` / `Ctrl+Down` | Adjust Receiver IF Bandwidth ($\pm 50\text{ Hz}$, `150`–`600 Hz`) |
| `PgUp` / `PgDn` | Adjust CW Keying Speed ($\pm 2\text{ WPM}$ in SST/CWT, $\pm 5\text{ WPM}$ in WPX) |
