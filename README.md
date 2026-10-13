# CareBridge

**A healthcare information-safety and care-coordination assistant.** Upload messy prescriptions, lab reports and discharge papers; CareBridge reads them, builds a timeline, finds conflicts and easy-to-miss follow-ups, shows exactly where each finding came from, and prepares a Doctor Visit Brief.

> **CareBridge is not a doctor.** It does not diagnose, prescribe, change doses, or tell anyone to stop a medicine. When documents disagree it says so and sends the person back to their clinician or pharmacist. This is a hackathon prototype, not a medical device. Do not rely on it for care decisions.

Built to be developed and run entirely from **Termux on an Android tablet or phone**: Node.js with **zero npm dependencies**, no build step, no database.

---

## What it does

| Step | What happens |
|---|---|
| Add documents | PDFs (read with a bundled copy of pdf.js), photos (AI vision, or on-device OCR), text files, pasted text |
| Extract | Medications and instructions, dates, follow-ups, flagged results, warning signs |
| Cross-check | Medication frequency, dose or "stop vs continue" differences across documents; different follow-up timings |
| Explain | Every finding shows **why it was flagged**, a **fixed, safe next step**, and a **question to ask** |
| Prove | Every finding links to the **document, page and exact quote**. Quotes the AI invents are dropped |
| What am I missing? | A second pass over all documents: unreferenced flagged results, follow-ups that are due or buried on the last page, medicines on one list but not another, unclear instructions, plus an optional AI "second reader" |
| Doctor Visit Brief | A one-page summary built in code from the verified findings: print, save as PDF, copy or share |

Example: if one document says "Take Metformin twice daily" and another says "once daily", CareBridge does **not** pick one. It shows both quotes side by side with:

> Potential instruction conflict detected. Two documents contain different instructions for the same medication. Please confirm the current instruction with your doctor or pharmacist.

---

## Quick start in Termux

1. **Install Termux** from [F-Droid](https://f-droid.org/packages/com.termux/) (the Play Store build is outdated).
2. **Install the tools** (Node.js 18 or newer is required):
   ```bash
   pkg update -y && pkg upgrade -y
   pkg install -y nodejs unzip nano git
   node -v
   ```
3. **Get the project into Termux.** Download `carebridge.zip` from the chat, then:
   ```bash
   termux-setup-storage              # tap "Allow" once
   cd ~
   cp ~/storage/downloads/carebridge.zip .
   unzip -o carebridge.zip
   cd carebridge
   ```
4. **Run the tests** (no install step is needed because there are no dependencies):
   ```bash
   npm test
   ```
5. **Start it:**
   ```bash
   cp .env.example .env              # optional: add an AI key later
   npm start
   ```
6. **Open** `http://localhost:8787` in Chrome on the same device. Tap **Try sample documents**.

Without an AI key CareBridge runs in **rules-only mode**: pattern-based extraction and all the cross-checks still work, and everything is labelled as such. Add a key to get AI reading of messy documents and photos.

To keep it alive while you switch apps: `termux-wake-lock` (and `termux-wake-unlock` when you are done).

### Try real files

The `samples/` folder has three PDFs (one of them with a sentence that wraps over two lines) and a phone-style photo of the prescription. Copy them somewhere Android's file picker can see:

```bash
mkdir -p ~/storage/downloads/carebridge-samples
cp samples/* ~/storage/downloads/carebridge-samples/
```

Then use **Choose files** and pick them from *Downloads / carebridge-samples*.

---

## Turn on the AI (free option)

1. Open <https://aistudio.google.com/apikey> in your browser, create a key.
2. Edit `.env` (`nano .env`):
   ```ini
   AI_PROVIDER=gemini
   AI_API_KEY=paste-your-key-here
   ```
3. Restart (`Ctrl+C`, then `npm start`). The header now says **AI-assisted**.

`AI_MODEL` defaults to `gemini-flash-latest`, an alias for Google's newest Flash model. Model names change, so if you ever see "model not found", run:

```bash
npm run models        # lists what your key can use; copy one into AI_MODEL
```

> **Privacy warning for free keys.** When AI is on, the extracted text of your documents (and photos, if you add any) is sent to the AI provider. Free tiers of some providers may use submitted content to improve their products: check the provider's current terms. **Use the sample documents or synthetic data for demos. Do not upload real patient records to a free key.** CareBridge shows a one-time consent notice before the first real upload.

### Other providers (swap by editing `.env`, no code changes)

```ini
# Any OpenAI-compatible API (Groq, OpenRouter, Together, OpenAI, local Ollama ...)
AI_PROVIDER=openai
AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=...
AI_MODEL=<model name from the provider's docs>

# Anthropic Claude
AI_PROVIDER=anthropic
AI_API_KEY=...
AI_MODEL=claude-haiku-4-5-20251001
```

Photos are sent to the provider for transcription when the model supports images; otherwise (or if that call fails) CareBridge reads them on the device with OCR.

---

## Make it faster (all free)

1. **Instant first results (built in).** With an AI key set, CareBridge now shows the built-in results in well under a second, then reads the documents with the AI in the background and updates the page when it is done. You never wait on a blank screen.
2. **Thinking is switched off for Gemini (built in).** Newer Gemini models "think" before answering, which can add many seconds. CareBridge asks for the least thinking (`AI_THINKING=off`, the default) and falls back automatically if a model does not support that.
3. **Use a lighter model.** In `.env` set `AI_MODEL=gemini-flash-lite-latest`, restart, and time it:
   ```bash
   npm run models   # lists the model names your key can use
   npm run bench    # times one analysis of the 3 sample documents
   ```
   Try two or three models and keep the fastest one that still reads the samples correctly.
4. **Fewer and shorter documents.** The AI time grows with the amount of text. Add only the pages you need.
5. **Groq free tier (optional, very fast).** Groq is an OpenAI-compatible service with a free plan. In `.env`: `AI_PROVIDER=openai`, `AI_BASE_URL=https://api.groq.com/openai/v1`, `AI_MODEL=openai/gpt-oss-120b` (check `npm run models`), and `AI_MAX_OUTPUT_TOKENS=4000`. Its free plan has small per-minute token limits (about 8,000 tokens per minute when I last checked), so the 3 sample documents fit but long documents may be refused. Limits change: check your Groq console.

Free tiers may use what you send to improve their products. Use the sample or made-up documents with them, not real medical records.

## Configuration reference

All settings are environment variables (or lines in `.env`). Nothing is hard-coded.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Where to listen. Use `HOST=0.0.0.0` when deploying |
| `TRUST_PROXY` | `0` | Set `1` behind a proxy/PaaS so client IP and HTTPS come from `X-Forwarded-*` |
| `AI_PROVIDER` | `gemini` if a key is set | `gemini`, `openai`, `anthropic` or `none` |
| `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | | Credentials and endpoint |
| `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS` | `90000`, `12000` | Request limits |
| `FALLBACK_TO_RULES` | `true` | If the AI call fails, fall back to the rules engine (with a notice) instead of an error |
| `ACCESS_CODE` | empty | If set, visitors must enter it before any analysis. **Use it on public demos** to protect your quota |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | `30`, `600000` | Requests per IP per window |
| `MAX_DOCS`, `MAX_PAGES_PER_DOC`, `MAX_CHARS_PER_DOC`, `MAX_TOTAL_CHARS` | `10`, `60`, `60000`, `150000` | Size limits. Too-large input is rejected with a clear message, never silently truncated |

---

## How it works

```
 Browser (vanilla JS, no build)                       Server (Node, zero dependencies)
 ─────────────────────────────                        ────────────────────────────────
 PDF  ── pdf.js (bundled) ─┐                          /api/analyze
 Photo ─ AI vision / OCR ──┼─ page text only ───────▶   1. validate + size-check input
 Text ─────────────────────┘   (files never uploaded)   2. AI extraction (JSON)  +  rules extraction
                                                         3. verify every quote against the documents
 Care Overview, Timeline,                                4. detect conflicts, compute dates, range checks
 Findings, Questions, Brief  ◀── verified analysis ──    5. safety-filter model text, attach fixed next steps
 Document viewer (highlights the quote)                  6. build questions + brief
                                                       /api/missing   second pass ("What am I missing?")
                                                       /api/transcribe  photo → text (AI vision)
```

**The AI proposes, code decides.** The model extracts facts with quotes. Code then:

- **Checks every quote** against the cited page (ignoring spacing and punctuation). Unmatched items are dropped and counted ("2 AI suggestions were hidden").
- **Detects medication conflicts itself** by comparing normalized names, frequencies (`BD`, `1-0-1`, `every 12 hours` all mean twice daily), doses and stop/continue status. The model never "decides" a conflict.
- **Calculates** follow-up due dates ("in 2 weeks" + the document date), flags values outside the printed reference range, and detects warning signs the document itself states.
- **Filters model-written text** for diagnoses, dose advice, "stop/start" instructions and reassurance, and replaces all "next steps" with fixed safe wording.
- **Never trusts document content as instructions.** Documents are fenced, angle brackets are neutralized, and the prompt states that text inside documents is data.

Unit-tested examples of what is blocked: "You likely have diabetes", "You should stop taking metformin", "Take 500 mg twice a day", "Nothing to worry about".

### Security notes

- Files are read in the browser; **only text and page numbers** are sent to the server. Nothing is written to disk, no database, request bodies are never logged.
- The analysis lives in the browser tab's `sessionStorage` and is gone when the tab closes; **Clear everything** wipes it immediately.
- Strict Content-Security-Policy (no inline scripts, no `eval`), `nosniff`, `no-referrer`, `frame-ancestors 'none'`, HSTS when behind HTTPS, `Cache-Control: no-store` on all API responses.
- All document text is inserted as text nodes, never as HTML. pdf.js runs with `isEvalSupported: false`.
- Body-size limits, per-IP rate limiting, JSON-only API, path-traversal-safe static server, constant-time access-code comparison, API key never sent to the browser.
- Always serve over HTTPS when deployed (Render and tunnels do this for you).

---

## Testing

```bash
npm test          # 36 tests: unit, pipeline, safety filter, API with mock AI providers, real PDFs
npm start         # in one Termux session ...
npm run smoke     # ... and this in another: checks a running server end to end
```

The API tests start a real CareBridge server and a mock AI server that speaks the **Gemini**, **OpenAI-compatible** and **Anthropic** wire formats. They verify auth headers, JSON mode, retry on 429, fallback when the provider fails, hallucinated quotes being dropped, unsafe wording being dropped, access code, rate limit and oversized requests.

### What has and has not been verified

Verified in the build environment: all 36 tests; 15 browser checks in headless Chromium (phone, tablet and desktop widths, dark mode, no horizontal overflow from 320 px up, real PDF upload through pdf.js, paste, remove, session reload, print to PDF, consent dialog); the end-to-end flow on the sample documents.

**Not** verified there (no internet, no Android): calls to the real Gemini/OpenAI/Anthropic services (the adapters follow their documented formats and are tested against mocks), the on-device Tesseract.js OCR engine (stubbed in tests; it downloads from a CDN on first use), Termux itself and Render. If something fails on your device, run `npm run smoke` and check the Troubleshooting section.

---

## Deploying

### Render (free tier, from GitHub)

1. In Termux, push the project to a new, private GitHub repository (create the empty repo in the browser first):
   ```bash
   cd ~/carebridge
   git config --global user.name  "Your Name"
   git config --global user.email "you@example.com"
   git init && git add . && git commit -m "CareBridge"
   git branch -M main
   git remote add origin https://github.com/YOUR-USER/carebridge.git
   git push -u origin main        # password = a GitHub personal access token
   ```
   `.env` is in `.gitignore`, so your key is not uploaded.
2. On <https://render.com>: **New > Blueprint**, pick the repo (it reads `render.yaml`), then add the secret values `AI_API_KEY` and `ACCESS_CODE` in the dashboard. Or create a plain **Web Service** with start command `node server.js` and the variables from the table above (`HOST=0.0.0.0`, `TRUST_PROXY=1`).
3. Open the `https://...onrender.com` URL. Free instances usually sleep when idle, so open it a minute before a demo.

Set an `ACCESS_CODE` and tell judges the code; otherwise anyone with the link can spend your AI quota.

### Quick public link straight from Termux (for a demo)

```bash
pkg install -y openssh
ssh -R 80:localhost:8787 nokey@localhost.run      # prints an https:// URL while the command runs
```

Any similar tunnel works (for example `cloudflared tunnel --url http://localhost:8787` if available in your Termux repo). Set `ACCESS_CODE` first.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `pkg` cannot download | `termux-change-repo`, pick another mirror, then `pkg update` |
| `Port 8787 is already in use` | `PORT=8800 npm start` |
| Chrome cannot open the page | Use `http://localhost:8787` (not `https`), and keep Termux running (`termux-wake-lock`) |
| File picker does not show your files | Copy them to `~/storage/downloads` (see *Try real files*) |
| "Rules-based analysis" although you set a key | `AI_API_KEY` is empty or the server was not restarted. The startup banner prints the mode |
| "AI service is busy or over its free limit" | Wait a minute, or switch `AI_MODEL`. CareBridge falls back to rules in the meantime |
| "model not found" | `npm run models`, then set `AI_MODEL` |
| Photo OCR fails | The first on-device OCR download needs internet. Use AI mode, or paste the text |
| A scanned PDF shows little text | Scanned pages are OCR'd (first 6 pages). For best results add clear photos of each page |

## Project layout

```
server.js            HTTP server: static files, JSON API, headers, rate limit, access code
src/config.js        env + .env loading           src/providers.js  Gemini / OpenAI-compatible / Anthropic
src/prompts.js       all prompts (safety rules)   src/schema.js     input validation, model-output coercion
src/rules.js         offline extraction engine    src/normalize.js  dates, frequencies, doses, ranges, quote matching
src/build.js         verification, conflicts, findings, questions    src/missing.js  "What am I missing?"
src/safety.js        wording filter + warning signs   src/brief.js  Doctor Visit Brief   src/samples.js  synthetic documents
public/              index.html, css/styles.css, js/{app,views,extract,api,dom}.js, vendor/pdfjs (bundled)
samples/             3 PDFs + 1 photo for trying real uploads     test/  node:test suites     scripts/  smoke + list-models
```

## Limitations

- Rules mode is pattern-based and English-only; AI mode is better but can still misread or miss things. Everything is shown with its source so a person can check.
- Brand names are not mapped to generic names, so "Glycomet" and "Metformin" are only matched when the document writes both.
- Day/month order such as `05/06/2026` is never guessed; those dates are shown without a calendar position.
- CareBridge only sees what is uploaded. It cannot know about other records, allergies not written down, or what a clinician said aloud.

## Licenses

CareBridge: MIT. Bundles [pdf.js](https://github.com/mozilla/pdf.js) 5.6 (Apache-2.0) in `public/vendor/pdfjs`. On-device OCR loads [tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0) from a CDN only when needed.
