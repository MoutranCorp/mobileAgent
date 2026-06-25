import fs from 'node:fs';
import path from 'node:path';

/**
 * UsageLedger — persists token/cost usage aggregated by day so the UI can show a
 * dashboard (today, last 7 days, all-time). Records one entry per `usage` event.
 * Stored at <stateDir>/usage.json. Costs are summed only when present (the flat
 * Max plan reports null cost → counted as 0 but turns still tracked).
 */
const MAX_DAYS = 120;

export class UsageLedger {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'usage.json');
    this.byDay = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* ignore */
    }
    return {};
  }
  _save() {
    // Trim to the most recent MAX_DAYS to bound file size.
    const keys = Object.keys(this.byDay).sort();
    if (keys.length > MAX_DAYS) {
      for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete this.byDay[k];
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.byDay, null, 2));
    } catch {
      /* ignore */
    }
  }

  record({ inTok = 0, outTok = 0, cost = null, profile } = {}) {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (local-ish, UTC)
    const d = (this.byDay[day] ||= { in: 0, out: 0, cost: 0, turns: 0, byProfile: {} });
    d.in += inTok || 0;
    d.out += outTok || 0;
    d.cost += cost || 0;
    d.turns += 1;
    if (profile) {
      const p = (d.byProfile[profile] ||= { in: 0, out: 0, cost: 0, turns: 0 });
      p.in += inTok || 0; p.out += outTok || 0; p.cost += cost || 0; p.turns += 1;
    }
    this._save();
  }

  summary() {
    const days = Object.entries(this.byDay)
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const today = days[0]?.date === new Date().toISOString().slice(0, 10) ? days[0] : { date: 'today', in: 0, out: 0, cost: 0, turns: 0 };
    const total = days.reduce((acc, d) => ({
      in: acc.in + d.in, out: acc.out + d.out, cost: acc.cost + d.cost, turns: acc.turns + d.turns,
    }), { in: 0, out: 0, cost: 0, turns: 0 });
    return { today, days: days.slice(0, 14), total };
  }
}
