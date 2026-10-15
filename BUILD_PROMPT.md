# Build: "Margin" — a local PDF reader where every highlight gets its own AI chat

## Context

I'm a CS student learning operating systems for the first time from a large textbook PDF (~1000 pages). Almost every paragraph has something I don't understand, so I want to ask an AI about it constantly.

The problem with one long chat: a question about chapter 4 and a question about chapter 9 end up in the same conversation even though they have nothing in common, and the context gets polluted and hard to revisit.

**The idea:** I highlight a chunk of text in the PDF → click "Open chat" → a chat opens in a column on the left of the PDF, already seeded with the highlighted text as context. Each chat is anchored to its highlight, fully independent of every other chat, can be minimized, reopened later to ask follow-ups about the same passage, or deleted. Several chats can be open and streaming at the same time.

Build a simple, **local-only** v1. No auth, no deployment, single user, runs with one command on my laptop.

---

## Core user flow (this is the spec — everything below supports it)

1. I open the app and pick a PDF (file picker or drag-and-drop). Previously opened PDFs appear in a "Recent" list so I can reopen them without the file picker.
2. The PDF renders as a continuous vertical scroll of pages with a selectable text layer.
3. I select some text. A small floating button **"💬 Open chat"** appears just above the end of the selection.
4. I click it. The selected text gets a persistent colored highlight in the PDF, and a new chat card appears in the left column showing:
   - the highlighted text as a quote block at the top (collapsible),
   - the page number,
   - an empty message input with focus already in it.
5. I type a question and press Enter. The answer streams in token by token, rendered as Markdown (code blocks with syntax highlighting).
6. I can keep asking follow-ups in that chat. Only that chat's own messages + its anchored passage are sent to the model.
7. **Minimize:** the card collapses into a small pill in a "Minimized" list in the left column. The highlight stays in the PDF, and a small pin/marker appears in the page margin next to it.
8. **Reopen:** clicking the highlight in the PDF, the margin pin, or the pill reopens the chat exactly where I left off.
9. **Delete:** removes the chat and its highlight (with a confirm step).
10. **Jump:** a button on each chat card scrolls the PDF to its highlight and briefly flashes it.
11. Multiple chats can be open at once and can stream simultaneously without interfering with each other.
12. If I close the browser and come back later, reopening the same PDF restores every highlight and every chat with full history, plus my last page and zoom.

---

## Tech stack

Keep it boring and simple.

- **Frontend:** Vite + React + TypeScript
- **PDF rendering:** `react-pdf` (wraps `pdfjs-dist`) with the text layer enabled; annotation layer disabled
- **State:** `zustand`
- **Persistence:** IndexedDB via `dexie` (PDF bytes, documents, chats all live in the browser)
- **Markdown:** `react-markdown` + `remark-gfm` + `rehype-highlight` (add `remark-math` + `rehype-katex` too — textbooks have math)
- **Backend:** a tiny Node + Express + TypeScript server whose only job is to proxy chat requests to the Anthropic API so the API key never reaches the browser
- **AI:** `@anthropic-ai/sdk`, streaming. Model from env var `CLAUDE_MODEL`, default `claude-sonnet-5-5`
- **Dev:** `npm run dev` starts both client and server with `concurrently`; Vite proxies `/api/*` to the server
- **Styling:** plain CSS or CSS modules — no heavy UI library needed

---

## Repo layout

```
margin/
  package.json            # scripts: dev, build, typecheck
  .env.example            # ANTHROPIC_API_KEY=, CLAUDE_MODEL=claude-sonnet-5-5, PORT=8787
  server/
    index.ts              # Express app, POST /api/chat (SSE stream)
    prompt.ts             # builds the system prompt from the anchor (easy for me to edit)
  src/
    main.tsx
    App.tsx               # layout: toolbar, chat column, PDF viewer
    db.ts                 # Dexie schema + helpers
    store.ts              # zustand store (docs, chats, streaming state)
    types.ts
    pdf/
      PdfViewer.tsx       # scroll container, lazy page rendering, zoom
      PdfPage.tsx         # one page: canvas + highlight layer + text layer + margin pins
      selection.ts        # turn a DOM Selection into an Anchor (normalized rects + text)
      SelectionButton.tsx # floating "Open chat" button
    chat/
      ChatColumn.tsx      # open chat cards + minimized pills + "all chats" list
      ChatCard.tsx        # one chat: header, quote, messages, input
      Message.tsx         # markdown rendering
      api.ts              # streamChat(): fetch + ReadableStream SSE parsing + AbortController
```

---

## Data model (`src/types.ts`)

```ts
// One PDF. id = SHA-256 of the file bytes, so the same book always maps to the same chats
// even if I rename or move the file.
type DocRecord = {
  id: string;
  name: string;
  pageCount: number;
  lastPage: number;
  zoom: number;
  addedAt: number;
  openedAt: number;
};

// Stored in a separate Dexie table so listing docs doesn't load megabytes of PDF.
type PdfBlob = { docId: string; data: Blob };

// Coordinates are NORMALIZED to the page (0..1), so highlights are zoom-independent.
type Rect = { page: number; x: number; y: number; w: number; h: number };

type Anchor = {
  page: number;          // 1-based page where the selection starts
  rects: Rect[];         // may span two pages
  text: string;          // the selected text, whitespace-normalized
  contextBefore: string; // ~1500 chars of page text before the selection
  contextAfter: string;  // ~1500 chars of page text after the selection
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  error?: string;
};

type Chat = {
  id: string;
  docId: string;
  anchor: Anchor;
  title: string;         // first ~6 words of the selection; editable inline
  color: string;         // picked from a small palette, cycles per new chat
  messages: Message[];
  state: 'open' | 'minimized';
  createdAt: number;
  updatedAt: number;
};
```

Dexie tables: `docs` (key `id`), `pdfs` (key `docId`), `chats` (key `id`, index `docId`).

Streaming state (is this chat currently streaming, its AbortController, partial text) lives only in the zustand store, keyed by chat id — not in IndexedDB. Persist a chat to IndexedDB when a user message is sent and when an assistant message finishes (or errors / is stopped).

---

## What gets sent to the model

Each chat is independent. A request contains **only**:
- a system prompt built from that chat's anchor + the document name,
- that chat's own message history.

Never send the whole book, and never mix messages from different chats.

`server/prompt.ts` (keep this in one obvious function so I can tweak it):

```
You are a patient tutor helping a student who is learning this subject for the first time.
They are reading "{docName}" and highlighted a passage on page {page}. Their questions are
about that passage unless they say otherwise.

How to answer:
- Explain clearly and concretely. Define jargon the first time you use it.
- Use small examples, analogies, or short C / pseudocode snippets when they help.
- Tie the explanation back to what the passage actually says.
- Keep answers focused; don't lecture about the whole chapter unless asked.
- If the question goes beyond the passage, answer it anyway.

Text around the highlight (for context):
<before>{contextBefore}</before>
<highlight>{text}</highlight>
<after>{contextAfter}</after>
```

**How to compute `contextBefore` / `contextAfter`:** get the page's text via `page.getTextContent()`, join items into one string, normalize whitespace on both it and the selection, find the selection's index, and slice ~1500 chars on each side. If the selection can't be found (hyphenation, ligatures, odd PDF text order), fall back to the first ~3000 chars of the page text as `contextBefore` and leave `contextAfter` empty.

---

## Backend (`server/index.ts`)

- `POST /api/chat`
  - body: `{ docName: string, anchor: Anchor, messages: { role, content }[] }`
  - response: Server-Sent Events (`text/event-stream`), one JSON object per `data:` line:
    - `{ "type": "delta", "text": "..." }`
    - `{ "type": "done" }`
    - `{ "type": "error", "message": "..." }`
- Use `client.messages.stream(...)` with `max_tokens: 4096`.
- If the client disconnects (`req.on('close')`), abort the upstream stream.
- Read `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `PORT` from `.env` (use `dotenv`). Fail on startup with a clear message if the key is missing.
- `GET /api/health` → `{ ok: true, model }`.

Client side (`src/chat/api.ts`): use `fetch` with a POST body and read the response with a `ReadableStream` reader (EventSource can't POST). One `AbortController` per chat so "Stop" only stops that chat.

---

## UI layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ [Open PDF]  os-concepts.pdf     Page [142]/1004    [−] 125% [+]       │
├────────────────────────┬─────────────────────────────────────────────┤
│ CHAT COLUMN (~420px,   │  PDF VIEWER (scrolls)                        │
│ resizable)             │                                              │
│                        │   ┌───────────── page 142 ─────────────┐     │
│ ┌ ● Page tables… p.142 │ ● │ … a page table maps virtual pages   │     │
│ │ [jump][–][🗑]        │pin│ to ███████████ frames …             │     │
│ │ > quoted highlight   │   │                                     │     │
│ │ messages…            │   └─────────────────────────────────────┘     │
│ │ [input………… ] [Send] │                                              │
│ └──────────────────    │                                              │
│ ┌ ● TLB miss… p.150    │                                              │
│ │ …                    │                                              │
│ └──────────────────    │                                              │
│ Minimized: (p.88 Fork) │                                              │
│            (p.301 …)   │                                              │
│ ▸ All chats (12)       │                                              │
└────────────────────────┴─────────────────────────────────────────────┘
```

- **Open chat cards** stack vertically in the left column, newest on top. Each card has its own scroll area with a max height (~60vh) so one long chat doesn't push everything off-screen. Header: color dot, title (click to rename), page badge, buttons: jump to highlight, minimize, delete. Show a "Stop" button while streaming and "Retry" on error.
- **Minimized** section: compact pills (`p.88 · Fork and exec`); click to reopen.
- **All chats** (collapsible): every chat in this document sorted by page, so I can browse my questions like an index. Clicking one opens it and jumps to it.
- **Input:** Enter sends, Shift+Enter newline, textarea auto-grows.
- **Empty state:** if no chats, the column shows a one-line hint: "Select text in the PDF and click Open chat."

---

## PDF viewer details

- **Lazy rendering:** the book is huge. Render a placeholder `div` of the right size for every page (use page 1's viewport as the default size; correct it when the real page renders). Only actually render pages within roughly ±2 screens of the viewport (IntersectionObserver), and unmount canvases that scroll far away.
- **Layer order inside each page (bottom → top):** canvas → highlight layer → text layer. The text layer is transparent and on top so selection keeps working over highlighted text.
- **Clicking a highlight:** because the text layer sits on top, detect it on `click` in the page: if there's no active selection and the click point (converted to normalized page coords) falls inside one of a chat's rects on this page, open that chat. If several overlap, open the most recent.
- **Margin pins:** small colored dot in the left margin of the page, vertically aligned with the first rect of each anchor. Pins need `pointer-events: auto` and are clickable.
- **Zoom:** −/+ buttons and Ctrl/Cmd + scroll. Keep the current page in view when zooming (remember page + offset fraction before re-render, restore after). Highlights don't need recalculating because rects are normalized.
- **Page input:** typing a number and pressing Enter jumps there. Update the displayed current page while scrolling.
- Save `lastPage` and `zoom` to the doc record (debounced).
- If a PDF has no text layer (scanned), show a banner saying selection won't work for it.

---

## Turning a selection into an Anchor (`src/pdf/selection.ts`)

- On `mouseup` (and `keyup` for shift+arrow selections) inside the viewer, read `window.getSelection()`. Ignore it if empty or not inside a text layer.
- Find the page element(s) the selection touches (each page wrapper has `data-page-number`).
- Use `range.getClientRects()`, then **clean them up**: drop zero-width/zero-height rects, drop rects that are almost the size of the whole page (pdf.js sometimes produces these), and merge rects on the same line that touch or overlap.
- Convert each rect to coordinates relative to its page wrapper and divide by the wrapper's width/height → normalized `Rect`.
- Normalize the selected text (collapse whitespace, rejoin `exam-\nple` hyphenation).
- Position the floating "Open chat" button above the last rect. Hide it on scroll, on Escape, or when the selection clears.
- Keyboard shortcut: Ctrl/Cmd + Shift + L opens a chat from the current selection.

## How to work

Work through all milestones in order without stopping to ask me, unless you are
truly blocked (e.g. a missing API key). After each milestone, verify it yourself
before moving on:
- npm run typecheck and npm run build must pass
- add a MOCK_AI=1 mode on the server that streams a fake reply, and use it for all tests
- generate a small test PDF with known text using pdf-lib (tests/fixtures/sample.pdf)
- write Playwright e2e tests for each milestone's user flow (open PDF, select text,
  open chat, send message, minimize/reopen/delete, reload restores state, two chats
  streaming at once) and make them pass
- take screenshots at 100% and 200% zoom and check highlights are aligned
If something fails, fix it before continuing. At the end, give me a short report:
what works, what you couldn't verify, and anything you'd want me to test by hand
with a real textbook PDF.

## Acceptance checklist

- [ ] `npm install && npm run dev` works with only `ANTHROPIC_API_KEY` set in `.env`.
- [ ] A 1000-page PDF scrolls smoothly and doesn't render every page up front.
- [ ] Selecting text shows "Open chat"; clicking it creates a highlighted, anchored chat.
- [ ] Highlights stay aligned at every zoom level.
- [ ] Answers stream and render Markdown, code, and math.
- [ ] Two chats streaming simultaneously don't interfere; Stop only stops its own chat.
- [ ] A chat's request contains only its own anchor + its own messages (verify by logging the request body on the server in dev).
- [ ] Minimize, reopen (via highlight, pin, and pill), delete, jump all work.
- [ ] Refreshing the page and reopening the same PDF restores all chats, highlights, last page, and zoom.
- [ ] The API key never appears in client code or network responses.

---

## Gotchas to handle

- **pdf.js worker in Vite:** set `pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()`, and make sure the `pdfjs-dist` version matches the one `react-pdf` expects.
- Import react-pdf's text layer CSS (`react-pdf/dist/Page/TextLayer.css`) or selection will be misaligned.
- Keep a stable reference to the PDF `file` prop / options object, or react-pdf reloads the document on every render.
- Streaming re-renders: subscribe each `ChatCard` to its own chat via zustand selectors so a token arriving in one chat doesn't re-render every chat or the PDF.
- Hashing a large PDF: use `crypto.subtle.digest('SHA-256', arrayBuffer)`.
- Large blobs in IndexedDB are fine, but don't load the blob when just listing recent docs.

---

## Out of scope for v1 (don't build, but don't paint the architecture into a corner)

- Accounts, deployment, multi-user, syncing
- Sending figures/diagrams as images to the model
- Using the PDF outline to tell the model which chapter/section the passage is in
- Retrieval over the whole book or memory shared across chats
- Draggable/floating chat windows and smarter handling of overlapping highlights
- Search across chats, exporting chats as Markdown notes, branching a chat

## Coding guidelines

- TypeScript strict mode, small focused components, no `any` unless unavoidable.
- No over-engineering: no Redux, no ORM, no component library.
- Put the system prompt, model name, context length (1500 chars), and color palette in obvious constants so I can tweak them.
- Write a short `README.md`: setup, `.env`, how to run, how it works in 5 bullet points.
