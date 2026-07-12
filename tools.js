// Tools the agent can call. Data is SYNTHETIC (no real bank APIs yet) — swap the
// runTool implementations for real integrations later. Each tool returns { data }
// (fed back to the model) and optional { cards } (typed payloads the client
// renders as widgets). The tool set is expected to grow — add a schema + a case.

function fmtINR(v) {
  if (v >= 1e7) return '₹' + (v / 1e7).toFixed(2) + 'Cr';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  return '₹' + Math.round(v).toLocaleString('en-IN');
}

// One mock customer, consistent with the greeting.
const CUSTOMER = {
  name: 'Anil', city: 'Pune', age: 42,
  savings: { balance: 185000 },
  homeLoan: { outstanding: 420000, ratePct: 8.65, emi: 9500, yearsLeft: 14, floating: true },
  fd: { amount: 120000, ratePct: 6.8, maturesInMonths: 2, interestOnMaturity: 13000 },
  goals: [{ name: "Priya's College", target: 400000, saved: 110000, etaYear: 2028 }],
  gold: { value: 230000, allocationPct: 18 },
};

// --- schemas (OpenAI-compatible function calling) ---------------------------
const TOOL_SCHEMAS = [
  { type: 'function', function: {
    name: 'get_account_overview',
    description: "Fetch the customer's money: savings balance, home loan, fixed deposit (FD), goals, and gold holdings. Call this before discussing their finances so you use real numbers.",
    parameters: { type: 'object', properties: {}, required: [] },
  } },
  { type: 'function', function: {
    name: 'project_sip',
    description: 'Project the future value of a monthly SIP (systematic investment) at ~11% p.a.',
    parameters: { type: 'object', properties: {
      monthly: { type: 'number', description: 'Monthly amount in rupees' },
      years: { type: 'number', description: 'Number of years' },
    }, required: ['monthly', 'years'] },
  } },
  { type: 'function', function: {
    name: 'estimate_refinance_savings',
    description: 'Estimate interest saved by refinancing the home loan to a lower annual rate.',
    parameters: { type: 'object', properties: {
      newRatePct: { type: 'number', description: 'New annual interest rate, in percent' },
    }, required: ['newRatePct'] },
  } },
];

// human-readable trace labels for the visible "why I'm suggesting this" strip
const TOOL_LABELS = {
  get_account_overview: () => 'Pulling your accounts',
  project_sip: (a) => `Projecting ${fmtINR(a.monthly || 0)}/mo over ${a.years || 0} yrs`,
  estimate_refinance_savings: (a) => `Checking refinance at ${a.newRatePct}%`,
};
export function toolLabel(name, args) {
  const f = TOOL_LABELS[name];
  return f ? f(args || {}) : name;
}

// --- implementations --------------------------------------------------------
const sipFV = (P, years, annual = 0.11) => {
  const i = annual / 12, n = years * 12;
  return P * ((Math.pow(1 + i, n) - 1) / i) * (1 + i);
};

function overviewCards() {
  const c = CUSTOMER, g = c.goals[0];
  const refi = Math.max(0, Math.round(c.homeLoan.outstanding * (c.homeLoan.ratePct - 8.0) / 100 * c.homeLoan.yearsLeft));
  return [
    { kind: 'loan', label: 'Home Loan', rate: `${c.homeLoan.ratePct}%`, save: fmtINR(refi), cta: 'See refinance options' },
    { kind: 'goal', label: `Goal · ${g.name}`, saved: fmtINR(g.saved), goal: fmtINR(g.target), pct: Math.round((g.saved / g.target) * 100), note: 'A little behind · needs ~₹2,000 more a month' },
    { kind: 'gold', label: 'Gold Holdings', current: fmtINR(c.gold.value), allocation: `${c.gold.allocationPct}%`, note: "Most families keep 5–10% · you're a little heavy" },
  ];
}

export function runTool(name, args) {
  switch (name) {
    case 'get_account_overview': {
      const c = CUSTOMER;
      return {
        data: {
          name: c.name, savingsBalance: c.savings.balance,
          homeLoan: c.homeLoan, fd: c.fd, goals: c.goals, gold: c.gold,
        },
        cards: overviewCards(),
      };
    }
    case 'project_sip': {
      const monthly = Number(args.monthly) || 0;
      const years = Number(args.years) || 0;
      const fv = sipFV(monthly, years);
      return { data: { monthly, years, futureValue: Math.round(fv), futureValueText: fmtINR(fv) }, cards: [{ kind: 'invest', monthly, years }] };
    }
    case 'estimate_refinance_savings': {
      const l = CUSTOMER.homeLoan;
      const newRate = Number(args.newRatePct) || l.ratePct;
      const saved = Math.max(0, Math.round(l.outstanding * (l.ratePct - newRate) / 100 * l.yearsLeft));
      return {
        data: { oldRatePct: l.ratePct, newRatePct: newRate, estimatedInterestSaved: saved, estimatedInterestSavedText: fmtINR(saved) },
        cards: [{ kind: 'loan', label: 'Home Loan · Refinance', rate: `${newRate}%`, save: fmtINR(saved), cta: 'Start refinance' }],
      };
    }
    default:
      return { data: { error: `unknown tool ${name}` } };
  }
}

export { TOOL_SCHEMAS };
