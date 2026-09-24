// Server profiler, off unless PROFILE=1 (PROFILE_CPU=1 also records a CPU profile).
//
// Collects, per match: simulation tick times, time spent per code section (nested
// sections are counted in their parents too), call counters, network traffic per
// message type, event loop delay, garbage collection and memory. At the end of a
// match (and when the server stops) it writes a readable summary and the raw data to
// PROFILE_DIR (default ./profiles).

import fs from 'node:fs';
import path from 'node:path';
import inspector from 'node:inspector';
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';

const ENABLED = process.env.PROFILE === '1' || process.env.PROFILE_CPU === '1';
const CPU = process.env.PROFILE_CPU === '1';
const DIR = path.resolve(process.env.PROFILE_DIR || 'profiles');
const TICK_BUDGET_MS = 1000 / 60;

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const ELD_RESOLUTION_MS = 10;
// The event loop histogram measures time between samples; subtract the sampling
// interval to get how late the loop actually was.
const lateMs = ns => round(Math.max(0, ns / 1e6 - ELD_RESOLUTION_MS), 2);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

class Profiler {
  constructor() {
    this.enabled = true;
    this.eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
    this.eld.enable();
    this.gc = { count: 0, total: 0, max: 0 };
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          this.gc.count++;
          this.gc.total += e.duration;
          this.gc.max = Math.max(this.gc.max, e.duration);
        }
      }).observe({ entryTypes: ['gc'] });
    } catch {}
    this.session = null;
    this.reset();
    fs.mkdirSync(DIR, { recursive: true });
    console.log(`[profile] enabled${CPU ? ' with CPU profiles' : ''}, reports go to ${DIR}`);
  }

  reset(meta = {}) {
    this.meta = { ...meta };
    this.startedAt = Date.now();
    this.sections = new Map();   // name -> { total, count, max }
    this.counters = new Map();
    this.net = new Map();        // type -> { msgs, bytes }
    this.netIn = new Map();
    this.ticks = [];             // tick durations in ms
    this.slowest = [];           // [{ ms, at, sections }]
    this.current = null;         // sections of the running tick
    this.timeline = [];
    this.memStart = process.memoryUsage();
    this.memPeak = { heapUsed: this.memStart.heapUsed, rss: this.memStart.rss };
    this.gc = { count: 0, total: 0, max: 0 };
    this.eld.reset();
  }

  begin() {
    return performance.now();
  }

  end(name, t0) {
    const ms = performance.now() - t0;
    let s = this.sections.get(name);
    if (!s) this.sections.set(name, s = { total: 0, count: 0, max: 0 });
    s.total += ms;
    s.count++;
    if (ms > s.max) s.max = ms;
    if (this.current) this.current[name] = (this.current[name] || 0) + ms;
    return ms;
  }

  count(name, n = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + n);
  }

  sent(type, bytes, recipients = 1) {
    let s = this.net.get(type);
    if (!s) this.net.set(type, s = { msgs: 0, bytes: 0 });
    s.msgs += recipients;
    s.bytes += bytes * recipients;
  }

  received(type, bytes) {
    let s = this.netIn.get(type);
    if (!s) this.netIn.set(type, s = { msgs: 0, bytes: 0 });
    s.msgs++;
    s.bytes += bytes;
  }

  tickStart() {
    this.current = {};
    return performance.now();
  }

  tickEnd(t0) {
    const ms = performance.now() - t0;
    this.ticks.push(ms);
    if (this.slowest.length < 10 || ms > this.slowest[this.slowest.length - 1].ms) {
      // a match can start in the middle of a tick, which resets the running tick
      const sections = Object.fromEntries(Object.entries(this.current || {}).map(([k, v]) => [k, round(v, 3)]));
      this.slowest.push({ ms: round(ms, 3), atSec: round((Date.now() - this.startedAt) / 1000, 1), sections });
      this.slowest.sort((a, b) => b.ms - a.ms);
      this.slowest.length = Math.min(this.slowest.length, 10);
    }
    this.current = null;
  }

  // Called every few seconds with the current game state.
  sample(gauges) {
    const mem = process.memoryUsage();
    this.memPeak.heapUsed = Math.max(this.memPeak.heapUsed, mem.heapUsed);
    this.memPeak.rss = Math.max(this.memPeak.rss, mem.rss);
    const recent = this.ticks.slice(this._lastTickIndex || 0);
    this._lastTickIndex = this.ticks.length;
    recent.sort((a, b) => a - b);
    const entry = {
      atSec: round((Date.now() - this.startedAt) / 1000, 1),
      tickAvgMs: round(recent.reduce((a, b) => a + b, 0) / (recent.length || 1), 3),
      tickP95Ms: round(percentile(recent, 0.95), 3),
      tickMaxMs: round(recent[recent.length - 1] || 0, 3),
      heapMB: round(mem.heapUsed / 1048576, 1),
      ...gauges,
    };
    this.timeline.push(entry);

    // Live line for `docker compose logs -f`: busiest sections since the last sample.
    const prev = this._lastSections || new Map();
    const deltas = [...this.sections.entries()]
      .map(([k, v]) => [k, v.total - (prev.get(k) || 0)])
      .sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, v]) => `${k} ${round(v / (recent.length || 1), 3)}`).join(', ');
    this._lastSections = new Map([...this.sections.entries()].map(([k, v]) => [k, v.total]));
    const g = Object.entries(gauges).map(([k, v]) => `${k} ${v}`).join(' ');
    console.log(`[profile] ${entry.atSec}s tick avg ${entry.tickAvgMs} p95 ${entry.tickP95Ms} max ${entry.tickMaxMs} ms | ms/tick: ${deltas} | ${g} | heap ${entry.heapMB} MB, loop delay p99 ${lateMs(this.eld.percentile(99))} ms`);
  }

  matchStart(meta) {
    this.reset(meta);
    if (CPU) this.startCpu();
  }

  async matchEnd(reason, extra = {}) {
    if (!this.ticks.length) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIR, `match-${stamp}`);
    const report = this.report(reason, extra);
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    fs.writeFileSync(`${base}.txt`, this.text(report));
    if (CPU) await this.stopCpu(`${base}.cpuprofile`);
    console.log(`[profile] wrote ${base}.txt`);
    this.reset();
  }

  startCpu() {
    try {
      this.session = new inspector.Session();
      this.session.connect();
      this.session.post('Profiler.enable');
      this.session.post('Profiler.start');
    } catch (e) {
      console.log('[profile] CPU profiling unavailable:', e.message);
      this.session = null;
    }
  }

  stopCpu(file) {
    const session = this.session;
    this.session = null;
    if (!session) return Promise.resolve();
    return new Promise(resolve => {
      session.post('Profiler.stop', (err, res) => {
        if (!err && res?.profile) fs.writeFileSync(file, JSON.stringify(res.profile));
        session.disconnect();
        resolve();
      });
    });
  }

  report(reason, extra) {
    const durSec = (Date.now() - this.startedAt) / 1000;
    const ticks = [...this.ticks].sort((a, b) => a - b);
    const sum = ticks.reduce((a, b) => a + b, 0);
    const mem = process.memoryUsage();
    const sections = [...this.sections.entries()]
      .map(([name, s]) => ({
        name, totalMs: round(s.total, 1), calls: s.count, avgMs: round(s.total / s.count, 4),
        maxMs: round(s.max, 3), perTickMs: round(s.total / (ticks.length || 1), 4),
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
    const net = [...this.net.entries()]
      .map(([type, s]) => ({ type, msgsPerSec: round(s.msgs / durSec, 1), kbPerSec: round(s.bytes / 1024 / durSec, 2), totalKB: round(s.bytes / 1024, 1) }))
      .sort((a, b) => b.kbPerSec - a.kbPerSec);
    const netIn = [...this.netIn.entries()]
      .map(([type, s]) => ({ type, msgsPerSec: round(s.msgs / durSec, 1), kbPerSec: round(s.bytes / 1024 / durSec, 2) }))
      .sort((a, b) => b.msgsPerSec - a.msgsPerSec);
    return {
      reason, ...this.meta, ...extra,
      durationSec: round(durSec, 1),
      ticks: {
        count: ticks.length, avgMs: round(sum / (ticks.length || 1), 3),
        p50Ms: round(percentile(ticks, 0.5), 3), p95Ms: round(percentile(ticks, 0.95), 3),
        p99Ms: round(percentile(ticks, 0.99), 3), maxMs: round(ticks[ticks.length - 1] || 0, 3),
        overBudget: ticks.filter(t => t > TICK_BUDGET_MS).length,
        budgetUsedPct: round(sum / (durSec * 1000) * 100, 1),
      },
      eventLoopDelayMs: {
        p50: lateMs(this.eld.percentile(50)), p99: lateMs(this.eld.percentile(99)),
        max: lateMs(this.eld.max),
      },
      gc: { count: this.gc.count, totalMs: round(this.gc.total, 1), maxPauseMs: round(this.gc.max, 2) },
      memoryMB: {
        heapStart: round(this.memStart.heapUsed / 1048576, 1), heapEnd: round(mem.heapUsed / 1048576, 1),
        heapPeak: round(this.memPeak.heapUsed / 1048576, 1), rssPeak: round(this.memPeak.rss / 1048576, 1),
      },
      sections,
      counters: Object.fromEntries([...this.counters.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v])),
      countersPerSec: Object.fromEntries([...this.counters.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round(v / durSec, 1)])),
      networkOut: net,
      networkIn: netIn,
      slowestTicks: this.slowest,
      timeline: this.timeline,
    };
  }

  text(r) {
    const lines = [];
    const pad = (s, n) => String(s).padEnd(n);
    const lpad = (s, n) => String(s).padStart(n);
    lines.push(`Splatter server profile (${r.reason})`);
    lines.push(`duration ${r.durationSec}s, humans ${r.humans ?? '?'}, bots ${r.bots ?? '?'}`);
    lines.push('');
    lines.push(`Simulation ticks (budget ${round(TICK_BUDGET_MS, 1)} ms)`);
    lines.push(`  ${r.ticks.count} ticks, avg ${r.ticks.avgMs} ms, p50 ${r.ticks.p50Ms}, p95 ${r.ticks.p95Ms}, p99 ${r.ticks.p99Ms}, max ${r.ticks.maxMs}`);
    lines.push(`  ${r.ticks.overBudget} ticks over budget, simulation used ${r.ticks.budgetUsedPct}% of wall time`);
    lines.push(`  catch-up steps (loop fell behind): ${r.counters['loop.catchupSteps'] || 0}`);
    lines.push(`Event loop delay: p50 ${r.eventLoopDelayMs.p50} ms, p99 ${r.eventLoopDelayMs.p99} ms, max ${r.eventLoopDelayMs.max} ms`);
    lines.push(`GC: ${r.gc.count} runs, ${r.gc.totalMs} ms total, longest pause ${r.gc.maxPauseMs} ms`);
    lines.push(`Memory: heap ${r.memoryMB.heapStart} -> ${r.memoryMB.heapEnd} MB (peak ${r.memoryMB.heapPeak}), rss peak ${r.memoryMB.rssPeak} MB`);
    lines.push('');
    lines.push('Time per section (nested sections are included in their parents)');
    lines.push(`  ${pad('section', 26)}${lpad('total ms', 11)}${lpad('ms/tick', 10)}${lpad('calls', 10)}${lpad('avg ms', 10)}${lpad('max ms', 9)}`);
    for (const s of r.sections) {
      lines.push(`  ${pad(s.name, 26)}${lpad(s.totalMs, 11)}${lpad(s.perTickMs, 10)}${lpad(s.calls, 10)}${lpad(s.avgMs, 10)}${lpad(s.maxMs, 9)}`);
    }
    lines.push('');
    lines.push('Counters (per second)');
    for (const [k, v] of Object.entries(r.countersPerSec)) lines.push(`  ${pad(k, 34)}${lpad(v, 10)}  (${r.counters[k]} total)`);
    lines.push('');
    lines.push('Network out');
    for (const n of r.networkOut) lines.push(`  ${pad(n.type, 10)}${lpad(n.msgsPerSec + ' msg/s', 14)}${lpad(n.kbPerSec + ' KB/s', 14)}`);
    lines.push('Network in');
    for (const n of r.networkIn) lines.push(`  ${pad(n.type, 10)}${lpad(n.msgsPerSec + ' msg/s', 14)}${lpad(n.kbPerSec + ' KB/s', 14)}`);
    lines.push('');
    lines.push('Slowest ticks');
    for (const t of r.slowestTicks) {
      const top = Object.entries(t.sections).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(', ');
      lines.push(`  ${lpad(t.ms, 8)} ms at ${t.atSec}s: ${top}`);
    }
    lines.push('');
    lines.push('Timeline (every 5 s)');
    for (const t of r.timeline) {
      const g = Object.entries(t).filter(([k]) => !['atSec', 'tickAvgMs', 'tickP95Ms', 'tickMaxMs', 'heapMB'].includes(k)).map(([k, v]) => `${k} ${v}`).join(', ');
      lines.push(`  ${lpad(t.atSec, 6)}s  tick avg ${t.tickAvgMs} p95 ${t.tickP95Ms} max ${t.tickMaxMs} ms, heap ${t.heapMB} MB, ${g}`);
    }
    return lines.join('\n') + '\n';
  }
}

const noop = () => {};
const disabled = {
  enabled: false, begin: () => 0, end: noop, count: noop, sent: noop, received: noop,
  tickStart: () => 0, tickEnd: noop, sample: noop, matchStart: noop, matchEnd: async () => {},
};

export const prof = ENABLED ? new Profiler() : disabled;
