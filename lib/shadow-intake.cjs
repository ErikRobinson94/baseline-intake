// lib/shadow-intake.cjs
// Minimal, safe shadow logger used by web-demo-live.
// Adjust extraction rules as you like.

function makeShadowIntake() {
  return {
    sessionStartedAt: new Date().toISOString(),
    kind: null,       // "existing" | "accident"
    name: null,
    phone: null,
    email: null,
    happened: null,
    when: null,
    city: null,
    state: null,
    notes: [],
  };
}

function norm(s) { return String(s || '').trim(); }

function updateIntakeFromUserText(intake, text) {
  const t = norm(text);

  // classify kind
  if (!intake.kind) {
    if (/\b(existing|client number|already.*client)\b/i.test(t)) intake.kind = 'existing';
    if (/\b(accident|crash|collision|injur|wreck)\b/i.test(t)) intake.kind = 'accident';
  }

  // simple pulls
  const phone = t.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/);
  if (phone && !intake.phone) intake.phone = phone[0];

  const email = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email && !intake.email) intake.email = email[0];

  const cityState = t.match(/\b([A-Za-z][A-Za-z\s]+),\s*([A-Za-z]{2})\b/);
  if (cityState) { intake.city = intake.city || cityState[1]; intake.state = intake.state || cityState[2]; }

  const when = t.match(/\b(?:today|yesterday|last\s+\w+|on\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?)\b/i);
  if (when && !intake.when) intake.when = when[0];

  // super naive "my name is" grab
  const name = t.match(/\b(my name is|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/);
  if (name && !intake.name) intake.name = name[2];

  if (t) intake.notes.push(t);
}

function intakeSnapshot(intake) {
  return {
    ...intake,
    notesCount: (intake.notes || []).length,
  };
}

module.exports = { makeShadowIntake, updateIntakeFromUserText, intakeSnapshot };
