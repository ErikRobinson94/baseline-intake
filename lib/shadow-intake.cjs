// lib/shadow-intake.cjs
function makeShadowIntake() {
  return {
    sessionStartedAt: new Date().toISOString(),
    kind: null, name: null, phone: null, email: null,
    happened: null, when: null, city: null, state: null,
    notes: [], notesCount: 0,
  };
}
function updateIntakeFromUserText(intake, text) {
  // Heuristic; keep it simple for demo. Add more rules as needed.
  if (!intake) return;
  intake.notes.push(text);
  intake.notesCount = intake.notes.length;

  // tiny pattern hints
  const mPhone = text.match(/(\+?1[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/);
  if (mPhone) intake.phone = intake.phone || mPhone[0];

  const mEmail = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (mEmail) intake.email = intake.email || mEmail[0];

  const mWhen = text.match(/\b(\d{1,2}\/\d{1,2}(\/\d{2,4})?)\b/i);
  if (mWhen) intake.when = intake.when || mWhen[0];
}
function intakeSnapshot(intake) {
  return { ...intake };
}
module.exports = { makeShadowIntake, updateIntakeFromUserText, intakeSnapshot };


