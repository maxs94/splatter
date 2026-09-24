// Minimal total-order HTN planner (SHOP style) with backtracking.
//
// Compound tasks have ordered methods: { name, cond(state, args), subtasks(state, args) }.
// The first method whose condition holds and whose subtasks can be planned wins.
// Primitive tasks (operators) have a precondition and an effect on a copy of the
// world state, so later tasks in the plan see the predicted state.

export const task = (name, args = {}) => ({ name, args });

export class Domain {
  constructor() {
    this.compound = new Map();
    this.primitive = new Map();
  }

  method(taskName, name, cond, subtasks) {
    if (!this.compound.has(taskName)) this.compound.set(taskName, []);
    this.compound.get(taskName).push({ name, cond, subtasks });
    return this;
  }

  operator(name, { cond = () => true, effect = () => {} } = {}) {
    this.primitive.set(name, { cond, effect });
    return this;
  }

  methods(taskName) {
    return this.compound.get(taskName) || [];
  }
}

// Returns { steps: [primitive tasks], trace: ['Task:method', ...] } or null.
export function plan(domain, state, tasks, depth = 0) {
  if (!tasks.length) return { steps: [], trace: [] };
  if (depth > 64) return null;
  const [head, ...rest] = tasks;

  const op = domain.primitive.get(head.name);
  if (op) {
    if (!op.cond(state, head.args)) return null;
    const next = { ...state };
    op.effect(next, head.args);
    const r = plan(domain, next, rest, depth + 1);
    return r && { steps: [head, ...r.steps], trace: r.trace };
  }

  const methods = domain.compound.get(head.name);
  if (!methods) throw new Error(`HTN: unknown task ${head.name}`);
  for (const m of methods) {
    if (!m.cond(state, head.args)) continue;
    const r = plan(domain, state, [...m.subtasks(state, head.args), ...rest], depth + 1);
    if (r) return { steps: r.steps, trace: [`${head.name}:${m.name}`, ...r.trace] };
  }
  return null;
}
