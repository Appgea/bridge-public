/**
 * The review deck: one batch of agent output, one piece at a time, full screen.
 *
 * Reviewing should feel like flipping through prints, not clearing an inbox. So: big media, the
 * keyboard does everything, sounds start on their own, and a verdict is one key. At the end the
 * verdicts become one message the agent can act on, sent straight into its terminal.
 *
 *   ← →    previous / next          Space   play / pause
 *   G      looks good               C       needs changes (a short note)
 *   Esc    close
 */
export type DeckItem = {
  project: string;
  path: string;
  /** The URL to load it from, versioned so a re-render is not served from cache. */
  src: string;
  /** Shown under the media and used in the feedback. */
  label: string;
  kind: "image" | "audio" | "video";
};

export type Verdict = { good: boolean; note: string };

export type DeckResult = {
  verdicts: Map<string, Verdict>;
};

export type DeckOptions = {
  title: string;
  /** Who the summary's Send goes to, or null when no agent is open on the project. */
  agentName: string | null;
  send(text: string): Promise<boolean>;
  copy(text: string): Promise<boolean>;
  /** The deck closed. `finished` is true when the summary was reached. */
  onClose(result: DeckResult, finished: boolean): void;
};

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** The feedback as the agent will read it: plain lines, file names it can find. */
export function feedbackText(items: DeckItem[], verdicts: Map<string, Verdict>): string {
  const lines = items
    .filter((item) => verdicts.has(item.path))
    .map((item) => {
      const verdict = verdicts.get(item.path)!;
      if (verdict.good) return `- ${item.label}: good`;
      return `- ${item.label}: needs changes${verdict.note ? ` — ${verdict.note}` : ""}`;
    });
  const changes = [...verdicts.values()].filter((verdict) => !verdict.good).length;
  const head = changes
    ? `I reviewed what you made. ${changes === 1 ? "One needs" : `${changes} need`} changes:`
    : "I reviewed what you made. All of it looks good:";
  return [head, ...lines].join("\n");
}

/**
 * A waveform for a sound, drawn once from the decoded file. It is what makes a list of takes
 * readable at a glance (silence, clipping, a long pause), and it doubles as the scrubber.
 */
async function drawWave(canvas: HTMLCanvasElement, url: string): Promise<number[] | null> {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const context = new AudioContext();
    const audio = await context.decodeAudioData(bytes);
    void context.close();
    const data = audio.getChannelData(0);
    const bars = 140;
    const step = Math.max(1, Math.floor(data.length / bars));
    const peaks: number[] = [];
    for (let bar = 0; bar < bars; bar++) {
      let peak = 0;
      for (let at = bar * step; at < Math.min(data.length, (bar + 1) * step); at += 16) {
        peak = Math.max(peak, Math.abs(data[at]));
      }
      peaks.push(peak);
    }
    const top = Math.max(...peaks, 0.01);
    return peaks.map((peak) => peak / top);
  } catch {
    canvas.classList.add("is-flat");
    return null;
  }
}

function paintWave(canvas: HTMLCanvasElement, peaks: number[] | null, progress: number): void {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ink = canvas.getContext("2d");
  if (!ink) return;
  ink.scale(ratio, ratio);
  const style = getComputedStyle(canvas);
  const played = style.getPropertyValue("--wave-played").trim() || "#9a88ff";
  const rest = style.getPropertyValue("--wave-rest").trim() || "#3a4258";
  const bars = peaks ?? new Array(140).fill(0.12);
  const gap = 2;
  const barWidth = Math.max(1, (width - gap * (bars.length - 1)) / bars.length);
  bars.forEach((peak, index) => {
    const barHeight = Math.max(2, peak * (height - 4));
    const x = index * (barWidth + gap);
    ink.fillStyle = (index + 0.5) / bars.length <= progress ? played : rest;
    ink.beginPath();
    ink.roundRect(x, (height - barHeight) / 2, barWidth, barHeight, barWidth / 2);
    ink.fill();
  });
}

export function openReviewDeck(items: DeckItem[], start: number, options: DeckOptions): void {
  if (!items.length) return;
  document.querySelector(".rd-veil")?.remove();
  const verdicts = new Map<string, Verdict>();
  let index = Math.min(Math.max(start, 0), items.length - 1);
  let summary = false;
  let noting = false;
  let player: HTMLMediaElement | null = null;
  const before = document.activeElement as HTMLElement | null;

  const veil = make("div", "rd-veil");
  veil.setAttribute("role", "dialog");
  veil.setAttribute("aria-modal", "true");
  veil.setAttribute("aria-label", `Review ${options.title}`);
  veil.tabIndex = -1;

  const top = make("header", "rd-top");
  const where = make("div", "rd-where");
  const counter = make("span", "rd-count");
  const close = make("button", "rd-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close review");
  close.title = "Close · Esc";
  top.append(where, counter, close);

  const stage = make("div", "rd-stage");
  const prev = make("button", "rd-nav is-prev", "‹");
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous");
  const next = make("button", "rd-nav is-next", "›");
  next.type = "button";
  next.setAttribute("aria-label", "Next");
  const frame = make("div", "rd-frame");
  stage.append(prev, frame, next);

  const caption = make("div", "rd-caption");
  const verdictBar = make("div", "rd-verdicts");
  const good = make("button", "rd-verdict is-good");
  good.type = "button";
  good.innerHTML = `<span>Looks good</span><kbd>G</kbd>`;
  const change = make("button", "rd-verdict is-change");
  change.type = "button";
  change.innerHTML = `<span>Needs changes</span><kbd>C</kbd>`;
  const note = make("form", "rd-note");
  const noteInput = make("input");
  noteInput.type = "text";
  noteInput.placeholder = "What should change? Enter saves, Esc skips the note";
  noteInput.setAttribute("aria-label", "What should change");
  note.append(noteInput);
  note.hidden = true;
  verdictBar.append(good, change);

  const strip = make("div", "rd-strip");
  const dock = make("footer", "rd-dock");
  dock.append(caption, verdictBar, note, strip);
  veil.append(top, stage, dock);

  where.append(make("b", "", options.title));

  function stopPlayer(): void {
    player?.pause();
    player = null;
  }

  function thumb(item: DeckItem, at: number): HTMLElement {
    const tile = make("button", `rd-thumb is-${item.kind}`);
    tile.type = "button";
    tile.title = item.label;
    if (item.kind === "image") {
      const image = make("img");
      image.src = item.src;
      image.alt = "";
      image.loading = "lazy";
      tile.append(image);
    } else {
      tile.append(make("span", "rd-thumb-glyph", item.kind === "audio" ? "♪" : "▶"));
    }
    const mark = make("i", "rd-mark");
    tile.append(mark);
    tile.addEventListener("click", () => go(at));
    return tile;
  }
  strip.append(...items.map(thumb));
  strip.hidden = items.length < 2;

  function paintStrip(): void {
    [...strip.children].forEach((child, at) => {
      const verdict = verdicts.get(items[at].path);
      child.classList.toggle("is-current", !summary && at === index);
      child.classList.toggle("is-good", verdict?.good === true);
      child.classList.toggle("is-change", verdict?.good === false);
    });
    strip.children[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function audioCard(item: DeckItem): HTMLElement {
    const card = make("div", "rd-audio");
    const audio = make("audio");
    audio.preload = "auto";
    audio.src = item.src;
    const play = make("button", "rd-play");
    play.type = "button";
    play.setAttribute("aria-label", "Play");
    const wave = make("canvas", "rd-wave");
    const time = make("span", "rd-time", "0:00");
    let peaks: number[] | null = null;
    const progress = (): number => (audio.duration ? audio.currentTime / audio.duration : 0);
    const repaint = (): void => {
      paintWave(wave, peaks, progress());
      time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration)}`;
      play.classList.toggle("is-playing", !audio.paused);
      play.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
    };
    void drawWave(wave, audio.src).then((found) => {
      peaks = found;
      repaint();
    });
    for (const name of ["timeupdate", "play", "pause", "loadedmetadata", "ended"]) {
      audio.addEventListener(name, repaint);
    }
    play.addEventListener("click", () => void (audio.paused ? audio.play() : audio.pause()));
    wave.addEventListener("click", (event) => {
      if (!audio.duration) return;
      const box = wave.getBoundingClientRect();
      audio.currentTime = ((event.clientX - box.left) / box.width) * audio.duration;
      void audio.play();
    });
    audio.addEventListener("error", () => card.classList.add("is-missing"), { once: true });
    card.append(play, wave, time, audio);
    player = audio;
    requestAnimationFrame(repaint);
    // A take is for hearing: it starts on arrival, the way the next track does.
    void audio.play().catch(() => undefined);
    return card;
  }

  function paintItem(): void {
    stopPlayer();
    const item = items[index];
    counter.textContent = `${index + 1} of ${items.length}`;
    caption.textContent = item.label;
    let body: HTMLElement;
    if (item.kind === "image") {
      const image = make("img", "rd-image");
      image.src = item.src;
      image.alt = item.label;
      image.addEventListener("error", () => frame.classList.add("is-missing"), { once: true });
      body = image;
    } else if (item.kind === "video") {
      const video = make("video", "rd-video");
      video.src = item.src;
      video.controls = true;
      video.autoplay = true;
      player = video;
      body = video;
    } else {
      body = audioCard(item);
    }
    frame.classList.remove("is-missing");
    frame.replaceChildren(body);
    const verdict = verdicts.get(item.path);
    good.classList.toggle("is-on", verdict?.good === true);
    change.classList.toggle("is-on", verdict?.good === false);
    prev.disabled = index === 0;
    next.disabled = false;
    // Preload the next picture so the flip is instant.
    const after = items[index + 1];
    if (after?.kind === "image") new Image().src = after.src;
    paintStrip();
  }

  function paintSummary(): void {
    stopPlayer();
    summary = true;
    counter.textContent = "Done";
    caption.textContent = "";
    const goodCount = [...verdicts.values()].filter((verdict) => verdict.good).length;
    const changeCount = verdicts.size - goodCount;
    const box = make("div", "rd-summary");
    box.append(make("b", "rd-summary-title", changeCount ? "Nice work. A few notes to send." : verdicts.size ? "All good." : "That was everything."));
    box.append(
      make(
        "p",
        "",
        [
          goodCount ? `${goodCount} looked good` : "",
          changeCount ? `${changeCount} need${changeCount === 1 ? "s" : ""} changes` : "",
          items.length - verdicts.size ? `${items.length - verdicts.size} skipped` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "Nothing marked.",
      ),
    );
    const text = feedbackText(items, verdicts);
    if (verdicts.size) {
      const preview = make("pre", "rd-feedback", text);
      box.append(preview);
    }
    const row = make("div", "rd-summary-actions");
    const done = make("button", "rd-btn", verdicts.size ? "Done without sending" : "Done");
    done.type = "button";
    done.addEventListener("click", () => finish(true));
    if (verdicts.size) {
      const send = make("button", "rd-btn is-primary", options.agentName ? `Send to ${options.agentName}` : "Copy feedback");
      send.type = "button";
      send.addEventListener("click", async () => {
        send.disabled = true;
        const ok = options.agentName ? await options.send(text) : await options.copy(text);
        send.textContent = ok ? (options.agentName ? "Sent" : "Copied") : "Could not send";
        if (ok) window.setTimeout(() => finish(true), 650);
        else send.disabled = false;
      });
      row.append(done, send);
      window.setTimeout(() => send.focus(), 0);
    } else {
      row.append(done);
      window.setTimeout(() => done.focus(), 0);
    }
    box.append(row);
    frame.classList.remove("is-missing");
    frame.replaceChildren(box);
    good.classList.remove("is-on");
    change.classList.remove("is-on");
    verdictBar.hidden = true;
    prev.disabled = false;
    next.disabled = true;
    paintStrip();
  }

  function go(at: number): void {
    closeNote(false);
    if (at >= items.length) {
      paintSummary();
      return;
    }
    summary = false;
    verdictBar.hidden = false;
    index = Math.max(0, at);
    paintItem();
  }

  function mark(isGood: boolean, text = ""): void {
    verdicts.set(items[index].path, { good: isGood, note: text });
    paintStrip();
    // A short beat so the mark is seen landing, then the next piece.
    good.classList.toggle("is-on", isGood);
    change.classList.toggle("is-on", !isGood);
    window.setTimeout(() => {
      if (!veil.isConnected || summary) return;
      go(index + 1);
    }, 220);
  }

  function openNote(): void {
    noting = true;
    verdictBar.hidden = true;
    note.hidden = false;
    noteInput.value = verdicts.get(items[index].path)?.note ?? "";
    noteInput.focus();
  }

  function closeNote(save: boolean): void {
    if (!noting) return;
    noting = false;
    note.hidden = true;
    verdictBar.hidden = summary;
    veil.focus();
    if (save) mark(false, noteInput.value.trim());
  }

  function finish(finished: boolean): void {
    stopPlayer();
    document.removeEventListener("keydown", onKey, true);
    veil.remove();
    before?.focus?.();
    options.onClose({ verdicts }, finished);
  }

  function onKey(event: KeyboardEvent): void {
    if (noting) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeNote(true);
      }
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "BUTTON" && (event.key === "Enter" || event.key === " ") && summary) return;
    const key = event.key.toLowerCase();
    const handled = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (key === "escape") return handled(), finish(summary);
    if (key === "arrowright" || key === "l") return handled(), go(summary ? index : index + 1);
    if (key === "arrowleft" || key === "h") return handled(), go(summary ? items.length - 1 : index - 1);
    if (summary) return;
    if (key === " ") {
      handled();
      if (player) void (player.paused ? player.play() : player.pause());
      return;
    }
    if (key === "g" || key === "y") return handled(), mark(true);
    if (key === "c" || key === "n") return handled(), openNote();
  }

  note.addEventListener("submit", (event) => {
    event.preventDefault();
    closeNote(true);
  });
  good.addEventListener("click", () => mark(true));
  change.addEventListener("click", openNote);
  prev.addEventListener("click", () => go(summary ? items.length - 1 : index - 1));
  next.addEventListener("click", () => go(index + 1));
  close.addEventListener("click", () => finish(summary));
  veil.addEventListener("click", (event) => {
    if (event.target === veil || event.target === stage) finish(summary);
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(veil);
  veil.focus();
  go(index);
}
