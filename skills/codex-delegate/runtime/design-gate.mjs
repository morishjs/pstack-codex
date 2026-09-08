import { createMachine, transition } from 'xstate';

const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const humanKinds = new Set(['product-policy', 'authority', 'irreversible']);
export const designMachine = createMachine({ id: 'design-readiness', initial: 'unassessed', states: {
  unassessed: { on: { CLEAR: 'ready', GRILL: 'grilling' } },
  grilling: { on: { READY: { target: 'ready', guard: ({ event }) => event.questions.length > 0 && event.questions.every(q => q.status === 'resolved') } } },
  ready: { type: 'final' },
} });
export const newDesignGate = () => ({ state: 'unassessed', reason: null, questions: [], evidence: [] });
function move(gate, type) {
  const [next] = transition(designMachine, designMachine.resolveState({ value: gate.state, context: {} }), { type, questions: gate.questions });
  ensure(next.value !== gate.state, 'design transition rejected'); gate.state = next.value;
}
export function designContext(gate) {
  const frontier = gate.questions.filter(q => q.status === 'open' && q.dependsOn.every(id => gate.questions.some(p => p.id === id && p.status === 'resolved')));
  return { ...gate, frontier, userQuestions: frontier.filter(q => humanKinds.has(q.kind)), agentQuestions: frontier.filter(q => !humanKinds.has(q.kind)) };
}
function addQuestions(gate, questions) {
  ensure(Array.isArray(questions) && questions.length, 'list concrete unresolved decisions');
  const added = [];
  for (const q of questions) {
    const known = [...gate.questions, ...added];
    ensure(q.id?.trim() && q.question?.trim() && ['technical', ...humanKinds].includes(q.kind), 'question needs ID, text and decision kind');
    ensure(!known.some(p => p.id === q.id) && Array.isArray(q.dependsOn) && q.dependsOn.every(id => known.some(p => p.id === id)), 'questions need unique IDs and existing prerequisites, ordered prerequisite-first');
    added.push({ ...q, status: 'open' });
  }
  gate.questions.push(...added);
}
export function updateDesign(gate, cycle, op, evidence) {
  ensure(evidence.length, 'design operation needs evidence');
  if (op.type === 'assess-design') {
    ensure(op.actorId === cycle.worker && gate.state === 'unassessed' && typeof op.clear === 'boolean' && op.reason?.trim(), 'worker assesses unresolved decisions once');
    if (op.clear) { ensure(Array.isArray(op.questions) && op.questions.length === 0, 'clear work cannot hide unresolved questions'); move(gate, 'CLEAR'); }
    else { addQuestions(gate, op.questions); move(gate, 'GRILL'); }
    gate.reason = op.reason; gate.evidence.push(...evidence);
  } else if (op.type === 'grill-question') {
    ensure(cycle.reviewer && op.actorId === cycle.reviewer && gate.state === 'grilling', 'retained reviewer asks the next design frontier');
    addQuestions(gate, op.questions); gate.evidence.push(...evidence);
  } else if (op.type === 'grill-answer') {
    ensure(op.actorId === cycle.worker && gate.state === 'grilling', 'retained worker supplies researched answers');
    const question = designContext(gate).frontier.find(q => q.id === op.id);
    ensure(question && op.answer?.trim() && ['requirement', 'assumption', 'out-of-scope'].includes(op.disposition), 'answer the current frontier and record its disposition');
    if (humanKinds.has(question.kind)) ensure(op.source === 'user' && op.userQuote?.trim() && evidence.some(e => e.kind === 'user-decision'), 'this decision needs actual existing or new user input; do not decide it autonomously');
    else ensure(op.source === 'code' || op.source === 'user', 'technical answers require code or existing user evidence');
    question.answer = { text: op.answer, source: op.source, userQuote: op.userQuote, disposition: op.disposition, evidence };
    question.status = 'answered';
  } else if (op.type === 'grill-confirm') {
    ensure(cycle.reviewer && op.actorId === cycle.reviewer && gate.state === 'grilling', 'retained reviewer confirms the answer');
    const question = gate.questions.find(q => q.id === op.id);
    ensure(question?.status === 'answered', 'question has no proposed answer');
    ensure(typeof op.accepted === 'boolean', 'confirm or reject the answer');
    if (op.accepted) { question.status = 'resolved'; question.confirmation = evidence; }
    else { (question.previousAnswers ??= []).push(question.answer); delete question.answer; question.status = 'open'; }
  } else if (op.type === 'design-ready') {
    ensure(cycle.reviewer && op.actorId === cycle.reviewer && gate.state === 'grilling', 'retained reviewer closes grilling');
    move(gate, 'READY'); gate.evidence.push(...evidence);
  } else throw new Error('unknown design operation');
}
export function validateDesignCoverage(gate, requirements) {
  ensure(gate.state === 'ready', 'resolve design decisions before freezing acceptance');
  for (const requirement of requirements) {
    ensure(Array.isArray(requirement.implementationFiles) && requirement.implementationFiles.length && requirement.verification?.trim(), 'each requirement needs implementation locations and verification method');
    ensure(Array.isArray(requirement.decisionIds) && requirement.decisionIds.every(id => gate.questions.some(q => q.id === id && q.status === 'resolved')), 'requirement references an unresolved or unknown design decision');
  }
  for (const q of gate.questions.filter(q => q.status === 'resolved' && q.answer?.disposition !== 'out-of-scope')) ensure(requirements.some(r => r.decisionIds.includes(q.id)), 'agreed design decision is missing from acceptance: ' + q.id);
}
