// Browser profiler, enabled with ?profile in the URL.
//
// Measures frame intervals and the work done per frame (split into sections), long
// tasks, network messages (rate, handling time, and the gaps between the server's
// position updates, which reveal server or network stalls), paint texture uploads,
// renderer stats and memory. Shows a small live panel. At the end of a match the
// report is uploaded to the server (saved in ./profiles when the server runs with
// PROFILE=1) and recording starts over; "Download report" saves everything recorded
// since then as a text file.

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
const STATE_INTERVAL_MS = 50; // server sends positions at 20 Hz

class Perf {
  constructor() {
    this.enabled = true;
    this.panel = document.createElement('div');
    this.panel.id = 'perfPanel';
    this.panel.innerHTML = '<pre></pre><div class="perf-buttons"><button type="button">Download report</button></div>';
    document.body.appendChild(this.panel);
    this.pre = this.panel.querySelector('pre');
    this.panel.querySelector('button').addEventListener('click', () => this.download());
    this.longTasks = { count: 0, total: 0, max: 0 };
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          this.longTasks.count++;
          this.longTasks.total += e.duration;
          this.longTasks.max = Math.max(this.longTasks.max, e.duration);
          this.window.longTask = Math.max(this.window.longTask || 0, e.duration);
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {}
    this.meta = {};
    this.reset();
  }

  reset() {
    this.startedAt = Date.now();
    this.sections = new Map();
    this.counters = new Map();
    this.net = new Map();
    this.frames = [];       // frame intervals (ms)
    this.work = [];         // work per frame (ms)
    this.slowest = [];
    this.current = null;
    this.lastFrame = 0;
    this.lastState = 0;
    this.stateGaps = [];
    this.timeline = [];
    this.longTasks = { count: 0, total: 0, max: 0 };
    this.window = this.freshWindow();
    this.lastSample = performance.now();
    this.lastPanel = 0;
  }

  freshWindow() {
    return { frames: [], work: [], gapMax: 0, longTask: 0, sections: new Map() };
  }

  begin() { return performance.now(); }

  end(name, t0) {
    const ms = performance.now() - t0;
    let s = this.sections.get(name);
    if (!s) this.sections.set(name, s = { total: 0, count: 0, max: 0 });
    s.total += ms; s.count++; if (ms > s.max) s.max = ms;
    this.window.sections.set(name, (this.window.sections.get(name) || 0) + ms);
    if (this.current) this.current[name] = (this.current[name] || 0) + ms;
    return ms;
  }

  count(name, n = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + n);
  }

  // A server message arrived and was handled in `ms`.
  message(type, bytes, ms) {
    let s = this.net.get(type);
    if (!s) this.net.set(type, s = { msgs: 0, bytes: 0, handleMs: 0, maxMs: 0 });
    s.msgs++; s.bytes += bytes; s.handleMs += ms; s.maxMs = Math.max(s.maxMs, ms);
    if (type === 'st') {
      const now = performance.now();
      if (this.lastState) {
        const gap = now - this.lastState;
        this.stateGaps.push(gap);
        this.window.gapMax = Math.max(this.window.gapMax, gap);
      }
      this.lastState = now;
    }
  }

  frameStart(now) {
    if (this.lastFrame) {
      const dt = now - this.lastFrame;
      this.frames.push(dt);
      this.window.frames.push(dt);
    }
    this.lastFrame = now;
    this.current = {};
    return performance.now();
  }

  frameEnd(t0, gauges) {
    const ms = performance.now() - t0;
    this.work.push(ms);
    this.window.work.push(ms);
    const interval = this.frames[this.frames.length - 1] || 0;
    if (this.slowest.length < 12 || interval > this.slowest[this.slowest.length - 1].intervalMs) {
      this.slowest.push({
        intervalMs: round(interval, 1), workMs: round(ms, 2), at: new Date().toISOString(),
        sections: Object.fromEntries(Object.entries(this.current || {}).map(([k, v]) => [k, round(v, 2)])),
      });
      this.slowest.sort((a, b) => b.intervalMs - a.intervalMs);
      this.slowest.length = Math.min(this.slowest.length, 12);
    }
    this.current = null;
    const now = performance.now();
    if (now - this.lastPanel > 1000) { this.lastPanel = now; this.drawPanel(gauges); }
    if (now - this.lastSample > 5000) { this.lastSample = now; this.sample(gauges); }
  }

  summarize(w) {
    const f = [...w.frames].sort((a, b) => a - b);
    const wk = [...w.work].sort((a, b) => a - b);
    const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    if (!f.length) return { fps: '-', frameAvg: '-', frameP95: '-', frameMax: '-', workAvg: round(avg(wk), 2), workMax: round(wk[wk.length - 1] || 0, 1) };
    return {
      fps: round(1000 / (avg(f) || 1), 1), frameAvg: round(avg(f), 1), frameP95: round(pct(f, 0.95), 1),
      frameMax: round(f[f.length - 1] || 0, 1), workAvg: round(avg(wk), 2), workMax: round(wk[wk.length - 1] || 0, 1),
    };
  }

  heapMB() {
    return performance.memory ? round(performance.memory.usedJSHeapSize / 1048576, 1) : null;
  }

  sample(gauges) {
    const s = this.summarize(this.window);
    const top = [...this.window.sections.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, v]) => [k, round(v / (this.window.work.length || 1), 2)]);
    this.timeline.push({
      at: new Date().toISOString(), atSec: round((Date.now() - this.startedAt) / 1000, 1), ...s,
      stateGapMaxMs: round(this.window.gapMax, 1), longTaskMaxMs: round(this.window.longTask || 0, 1),
      heapMB: this.heapMB(), topSectionsMsPerFrame: Object.fromEntries(top), ...gauges,
    });
    this.window = this.freshWindow();
  }

  drawPanel(g = {}) {
    const s = this.summarize(this.window);
    const top = [...this.window.sections.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, v]) => `  ${k.padEnd(14)} ${round(v / (this.window.work.length || 1), 2)} ms`).join('\n');
    const gap = this.window.gapMax;
    this.pre.textContent =
      `${s.fps} fps  frame avg ${s.frameAvg} p95 ${s.frameP95} max ${s.frameMax} ms\n` +
      `work avg ${s.workAvg} max ${s.workMax} ms  long task ${round(this.window.longTask || 0, 0)} ms\n` +
      `server updates: max gap ${round(gap, 0)} ms${gap > STATE_INTERVAL_MS * 3 ? '  << stall' : ''}\n` +
      `${top}\n` +
      `overlays ${g.overlays ?? '-'} (live ${g.liveFlows ?? '-'})  drops ${g.drops ?? '-'}  prints ${g.footprints ?? '-'}\n` +
      `draw calls ${g.calls ?? '-'}  textures ${g.textures ?? '-'}  heap ${this.heapMB() ?? '-'} MB`;
  }

  report(reason) {
    const durSec = (Date.now() - this.startedAt) / 1000;
    const f = [...this.frames].sort((a, b) => a - b);
    const wk = [...this.work].sort((a, b) => a - b);
    const gaps = [...this.stateGaps].sort((a, b) => a - b);
    const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    return {
      kind: 'client', reason, ...this.meta,
      startedAt: new Date(this.startedAt).toISOString(), endedAt: new Date().toISOString(),
      durationSec: round(durSec, 1), userAgent: navigator.userAgent,
      screen: `${innerWidth}x${innerHeight} @${devicePixelRatio}x`,
      frames: {
        count: f.length, fps: round(1000 / (avg(f) || 1), 1), avgMs: round(avg(f), 2),
        p50Ms: round(pct(f, 0.5), 1), p95Ms: round(pct(f, 0.95), 1), p99Ms: round(pct(f, 0.99), 1),
        maxMs: round(f[f.length - 1] || 0, 1),
        over33ms: f.filter(x => x > 33.4).length, over100ms: f.filter(x => x > 100).length,
      },
      workPerFrame: { avgMs: round(avg(wk), 2), p95Ms: round(pct(wk, 0.95), 2), maxMs: round(wk[wk.length - 1] || 0, 1) },
      longTasks: { count: this.longTasks.count, totalMs: round(this.longTasks.total, 0), maxMs: round(this.longTasks.max, 0) },
      serverUpdateGaps: {
        expectedMs: STATE_INTERVAL_MS, p50Ms: round(pct(gaps, 0.5), 1), p99Ms: round(pct(gaps, 0.99), 1),
        maxMs: round(gaps[gaps.length - 1] || 0, 1),
        over150ms: gaps.filter(x => x > 150).length, over500ms: gaps.filter(x => x > 500).length,
      },
      heapMB: this.heapMB(),
      sections: [...this.sections.entries()].map(([name, s]) => ({
        name, totalMs: round(s.total, 1), perFrameMs: round(s.total / (wk.length || 1), 3),
        calls: s.count, avgMs: round(s.total / s.count, 3), maxMs: round(s.max, 2),
      })).sort((a, b) => b.totalMs - a.totalMs),
      counters: Object.fromEntries([...this.counters.entries()].sort((a, b) => b[1] - a[1])),
      network: [...this.net.entries()].map(([type, s]) => ({
        type, msgsPerSec: round(s.msgs / durSec, 1), kbPerSec: round(s.bytes / 1024 / durSec, 2),
        handleMsTotal: round(s.handleMs, 1), handleMsMax: round(s.maxMs, 2),
      })).sort((a, b) => b.msgsPerSec - a.msgsPerSec),
      slowestFrames: this.slowest,
      timeline: this.timeline,
    };
  }

  text(r) {
    const L = [];
    const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
    L.push(`Splatter browser profile (${r.reason}) ${r.startedAt} to ${r.endedAt}`);
    L.push(`player ${r.name ?? '?'}, ${r.durationSec}s, ${r.screen}, ${r.userAgent}`);
    L.push('');
    L.push(`Frames: ${r.frames.fps} fps, avg ${r.frames.avgMs} ms, p95 ${r.frames.p95Ms}, p99 ${r.frames.p99Ms}, max ${r.frames.maxMs}`);
    L.push(`  ${r.frames.over33ms} frames over 33 ms, ${r.frames.over100ms} over 100 ms`);
    L.push(`Work per frame (our code): avg ${r.workPerFrame.avgMs} ms, p95 ${r.workPerFrame.p95Ms}, max ${r.workPerFrame.maxMs}`);
    L.push(`Long tasks: ${r.longTasks.count}, ${r.longTasks.totalMs} ms total, longest ${r.longTasks.maxMs} ms`);
    L.push(`Server position updates (every ${r.serverUpdateGaps.expectedMs} ms): p50 gap ${r.serverUpdateGaps.p50Ms}, p99 ${r.serverUpdateGaps.p99Ms}, max ${r.serverUpdateGaps.maxMs} ms`);
    L.push(`  ${r.serverUpdateGaps.over150ms} gaps over 150 ms, ${r.serverUpdateGaps.over500ms} over 500 ms (stalls on the server or network)`);
    L.push(`JS heap: ${r.heapMB ?? 'n/a'} MB`);
    L.push('');
    L.push('Time per section (nested sections are included in their parents)');
    L.push(`  ${pad('section', 18)}${lpad('total ms', 11)}${lpad('ms/frame', 10)}${lpad('calls', 9)}${lpad('avg ms', 9)}${lpad('max ms', 9)}`);
    for (const s of r.sections) L.push(`  ${pad(s.name, 18)}${lpad(s.totalMs, 11)}${lpad(s.perFrameMs, 10)}${lpad(s.calls, 9)}${lpad(s.avgMs, 9)}${lpad(s.maxMs, 9)}`);
    L.push('');
    L.push('Counters');
    for (const [k, v] of Object.entries(r.counters)) L.push(`  ${pad(k, 28)}${lpad(v, 12)}`);
    L.push('');
    L.push('Network in (handling time on the main thread)');
    for (const n of r.network) L.push(`  ${pad(n.type, 10)}${lpad(n.msgsPerSec + ' msg/s', 13)}${lpad(n.kbPerSec + ' KB/s', 12)}   handle total ${n.handleMsTotal} ms, max ${n.handleMsMax} ms`);
    L.push('');
    L.push('Slowest frames');
    for (const s of r.slowestFrames) {
      const top = Object.entries(s.sections).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(', ');
      L.push(`  ${lpad(s.intervalMs, 7)} ms (our work ${s.workMs} ms) at ${s.at}: ${top || '-'}`);
    }
    L.push('');
    L.push('Timeline (every 5 s)');
    for (const t of r.timeline) {
      const top = Object.entries(t.topSectionsMsPerFrame).map(([k, v]) => `${k} ${v}`).join(', ');
      L.push(`  ${t.at.slice(11, 19)} ${t.fps} fps, frame p95 ${t.frameP95} max ${t.frameMax}, work max ${t.workMax}, server gap max ${t.stateGapMaxMs}, long task ${t.longTaskMaxMs}, heap ${t.heapMB} | ${top} | overlays ${t.overlays}, drops ${t.drops}, draw calls ${t.calls}`);
    }
    return L.join('\n') + '\n';
  }

  // Ends the recording (match over): uploads the report and starts over.
  async finish(reason) {
    if (!this.work.length) return;
    this.sample({});
    const report = this.report(reason);
    const body = JSON.stringify({ report, text: this.text(report) });
    this.reset();
    try {
      await fetch('/api/client-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch {}
  }

  // Saves what was recorded so far as a text file and keeps recording.
  download() {
    if (!this.work.length) return;
    this.sample({});
    const report = this.report('downloaded');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.text(report)], { type: 'text/plain' }));
    a.download = `splatter-browser-${report.endedAt.replace(/[:.]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Page is going away: send what we have.
  flushOnExit(reason) {
    if (!this.work.length || !navigator.sendBeacon) return;
    const report = this.report(reason);
    navigator.sendBeacon('/api/client-profile', new Blob([JSON.stringify({ report, text: this.text(report) })], { type: 'application/json' }));
  }
}

const noop = () => {};
const disabled = {
  enabled: false, begin: () => 0, end: noop, count: noop, message: noop,
  frameStart: () => 0, frameEnd: noop, finish: async () => {}, flushOnExit: noop, reset: noop, meta: {},
};

export const perf = new URLSearchParams(location.search).has('profile') ? new Perf() : disabled;
