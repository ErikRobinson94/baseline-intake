// lib/shadow-intake.cjs
function sanitizeASCII(str) {
  if (!str) return '';
  return String(str).replace(/[\u0000-\u001F\u007F-\uFFFF]/g, ' ').replace(/\s+/g, ' ').trim();
}
function compact(s, max = 380) {
  if (!s) return '';
  const t = s.length <= max ? s : s.slice(0, max);
  if (t.length >= 40) return t;
  return 'You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.';
}

function makeIntakeState() {
  return {
    client_type: null, full_name: null, phone: null, email: null,
    incident: null, date: null, location: null,
    transcripts: [], _recentUtterances: [], completeLogged: false,
  };
}
const toTitle = s => (s||'').replace(/\b([a-z])/gi, m => m.toUpperCase());
const extractPhone = t => {
  const s = (t||'').replace(/[^\d\+]/g, '');
  const m = s.match(/(?:\+1)?(\d{10})$/);
  return m ? m[0].replace(/(\d{1,2})(\d{3})(\d{3})(\d{4})/, (x,c,a,b,d)=> (x.length===10?`${a}-${b}-${d}`:`+${c} ${a}-${b}-${d}`)) : null;
};
const extractEmail = t => {
  const m = (t||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
};
const extractClientType = t => {
  const s = (t||'').toLowerCase();
  if (/\b(existing|current|already.*client)\b/.test(s)) return 'existing';
  if (/\b(new|potential|not.*client|accident|injury|case)\b/.test(s)) return 'new';
  return null;
};
const extractFullName = t => {
  if (!t) return null;
  let m = t.match(/\b(?:my name is|this is|i am|i'm)\s+([a-z][a-z\s\.'-]{2,})$/i);
  if (m) {
    const cand = m[1].replace(/\s+/g, ' ').trim();
    if (cand.split(/\s+/).length >= 2) return toTitle(cand);
  }
  m = t.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/);
  return m ? m[1] : null;
};
const extractDate = t => {
  if (!t) return null;
  const m =
    t.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?/i) ||
    t.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/) ||
    t.match(/\b(?:yesterday|today|last\s+(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?)\b/i);
  return m ? m[0] : null;
};
const extractLocation = t => {
  if (!t) return null;
  let m = t.match(/\b(?:in|at)\s+([A-Za-z][A-Za-z\.\-']+(?:\s+[A-Za-z\.\-']+)*)(?:,\s*([A-Za-z]{2,}))?\b/);
  if (!m) return null;
  const phrase = m[1].trim();
  if (/^(an?|the)\s+(accident|injury|crash)\b/i.test(phrase)) return null;
  const city = toTitle(phrase);
  const st   = m[2] ? m[2].toUpperCase() : '';
  return st ? `${city}, ${st}` : city;
};
const looksIncidenty = t => /\b(accident|injury|fell|fall|collision|crash|rear[- ]?ended|hit|dog bite|bite|slip|trip|work|car|uber|lyft|truck|bicycle|pedestrian|bus|motorcycle)\b/i.test(t||'');
function isComplete(intake) {
  return !!(intake.client_type && intake.full_name && (intake.phone || intake.email) && intake.incident && intake.date && intake.location);
}
function intakeSnapshot(intake) {
  const { client_type, full_name, phone, email, incident, date, location } = intake;
  return { client_type, full_name, phone, email, incident, date, location, complete: isComplete(intake) };
}
function updateIntakeFromUserText(intake, text, logger = () => {}) {
  const incoming = (text || '').trim();
  if (!incoming) return;
  const recent = intake._recentUtterances || (intake._recentUtterances = []);
  if (recent.includes(incoming)) return;
  recent.push(incoming);
  if (recent.length > 25) recent.shift();
  intake.transcripts.push(incoming);

  let changed = false;
  const maybe = (label, val) => {
    if (val && !intake[label]) { intake[label] = val; changed = true; logger('info','intake_field',{ field: label, value: intake[label] }); }
  };
  maybe('client_type', extractClientType(incoming));
  maybe('full_name',   extractFullName(incoming));
  maybe('phone',       extractPhone(incoming));
  maybe('email',       extractEmail(incoming));
  maybe('date',        extractDate(incoming));
  maybe('location',    extractLocation(incoming));
  if (!intake.incident) {
    const words = incoming.split(/\s+/);
    if (looksIncidenty(incoming) || words.length >= 6) {
      intake.incident = incoming; changed = true; logger('info','intake_field',{ field: 'incident', value: intake.incident });
    }
  }
  if (changed) logger('info','intake_snapshot', intakeSnapshot(intake));
}

module.exports = {
  sanitizeASCII, compact,
  makeIntakeState, updateIntakeFromUserText, intakeSnapshot, isComplete,
};
