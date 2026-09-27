// Role tailoring: whatever the candidate types in the "Role" box (plus an optional job posting)
// decides who the interviewer is and what it asks.
//
// - Gemini on: interviewer.js puts the role, the job details and the matching "track" below into the
//   system prompt, so Gemini plays the hiring manager for that exact job.
// - Gemini off, slow or failing: roleQuestions() builds a role-specific question list from the same
//   tracks, so the fallback interview is still about the job, not generic HR questions.

export const DEFAULT_ROLE = 'Software Engineering Intern';
const MAX_ROLE_CHARS = 120;
const MAX_DETAILS_CHARS = 4000;

export function normalizeRole(role) {
  const r = String(role ?? '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ROLE_CHARS);
  return r || DEFAULT_ROLE;
}

export function normalizeJobDetails(details) {
  return String(details ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DETAILS_CHARS);
}

// "Senior Nurse" -> "senior", "IT Help Desk Intern" -> "entry". Used to pitch difficulty.
export function seniorityOf(role) {
  const r = role.toLowerCase();
  if (/\b(intern|internship|co-?op|student|trainee|apprentice|entry|junior|jr\.?|associate|graduate|new grad)\b/.test(r)) return 'entry';
  if (/\b(senior|sr\.?|lead|principal|staff|head|director|manager|chief|vp|architect)\b/.test(r)) return 'senior';
  return 'mid';
}

// Each track: how to recognise it, who the interviewer is, what a real interviewer digs into,
// and fallback questions ({role} is replaced with the candidate's role).
const TRACK_LIST = [
  {
    id: 'legal',
    match: /\b(paralegal|attorney|lawyer|legal|law clerk|counsel|compliance|contracts? (manager|specialist|administrator))\w*\b/i,
    interviewer: 'a supervising attorney who hires paralegals, clerks and associates',
    topics: 'legal research and citing sources, drafting and proofreading documents, deadlines and docketing, confidentiality and privilege, conflicts of interest, client communication, managing many matters at once, ethics, attention to detail',
    questions: [
      'You find a filing deadline tomorrow that nobody put on the calendar. Walk me through the next hour.',
      'How do you research a legal question you know nothing about? Where do you start?',
      'A client calls asking for advice while the attorney is out. What do you say?',
      'Tell me about a time you caught an error in a document before it went out.',
      'What does attorney-client privilege protect, and how could someone accidentally waive it?',
      'You are juggling six matters and two attorneys both say theirs is urgent. How do you prioritise?',
    ],
  },
  {
    id: 'security',
    match: /\b(cyber|security|infosec|soc\b|pentest|penetration|red team|blue team|threat|incident response|grc|forensic|vulnerab|appsec)\w*\b/i,
    interviewer: 'a security operations lead who has run incident response and hires analysts and engineers',
    topics: 'triaging alerts and false positives, incident response steps, common attacks (phishing, credential stuffing, ransomware, lateral movement), logs and SIEM queries, network fundamentals, least privilege and IAM, vulnerability management and patch priority, frameworks like NIST and MITRE ATT&CK, explaining risk to non-technical people, ethics and scope',
    questions: [
      'You get an alert at 2 a.m. that a user logged in from two countries ten minutes apart. Walk me through exactly what you do.',
      'A phishing email got through and three people clicked the link. What are your first five steps?',
      'How would you explain the difference between a vulnerability, a threat, and a risk to our CFO?',
      'We have forty critical vulnerabilities and time to patch ten this week. How do you decide which ten?',
      'Tell me about a security tool or lab you have set up yourself. What broke and how did you fix it?',
      'What does least privilege look like in practice, and where do teams usually get it wrong?',
      'Tell me about a time you found a problem nobody asked you to look for. What did you do with it?',
      'Where do you stay current on threats, and what is something you learned in the last month?',
    ],
  },
  {
    id: 'it',
    match: [/\bIT\b/, /\b(help ?desk|service desk|desktop support|tech support|technical support|sys ?admin|system administrator|network|infrastructure|cloud|devops|sre|site reliability|administrator)\w*\b/i],
    interviewer: 'an IT infrastructure manager who has worked the help desk and the server room',
    topics: 'troubleshooting methodology, Active Directory and user accounts, networking (DNS, DHCP, VLANs, VPN), Windows and Linux administration, backups and recovery, ticket prioritisation, documentation, scripting and automation, change management, outages and on-call, dealing with frustrated users',
    questions: [
      'A user says the internet is down, but only for them. Walk me through how you troubleshoot it, step by step.',
      'The CEO and an intern both open urgent tickets at the same time. How do you prioritise?',
      'Explain how DNS works to me as if I were a new help desk hire.',
      'Tell me about a time you automated something repetitive. What did it save?',
      'A backup job has been silently failing for a week. How would you find out, and what do you do now?',
      'Walk me through onboarding a new employee: accounts, access, devices. What is easy to forget?',
      'Tell me about the worst outage you have dealt with, even in a lab. What did you change afterward?',
      'How do you handle a user who is angry and insists the problem is your fault?',
    ],
  },
  {
    id: 'data',
    match: /\b(data|analyst|analytics|machine learning|ml|ai engineer|scientist|statistic|bi |business intelligence|quant)\w*\b/i,
    interviewer: 'a data science manager who reviews analyses and models for production',
    topics: 'SQL and data cleaning, experiment design and A/B tests, statistics intuition, choosing metrics, bias and leakage, model evaluation, communicating findings to stakeholders, dashboards, messy real-world data',
    questions: [
      'Our signups dropped fifteen percent last week. How would you figure out why?',
      'Walk me through how you would design an A/B test for a new checkout button. What could go wrong?',
      'Tell me about a dataset that was messier than you expected. What did you do about it?',
      'Your model is ninety-eight percent accurate. Why might that still be a bad model?',
      'How would you explain a confidence interval to a marketing manager?',
      'Tell me about an analysis where the answer was not what stakeholders wanted to hear.',
      'Write out loud the SQL you would use to find each customer\'s most recent order.',
      'How do you decide which metric actually matters for a product?',
    ],
  },
  {
    id: 'software',
    match: /\b(software|developer|engineer|engineering|programmer|coder|front ?end|back ?end|full ?stack|web|mobile|ios|android|swe|qa|test automation|game dev)\w*\b/i,
    interviewer: 'an engineering manager who still reviews code and runs technical interviews',
    topics: 'debugging a real bug, design trade-offs, data structures and complexity at a practical level, APIs and databases, testing, code review, version control, scaling and performance, reading unfamiliar code, estimating and shipping, working with product and design',
    questions: [
      'Walk me through the hardest bug you have tracked down. How did you find the root cause?',
      'You inherit a slow API endpoint that takes eight seconds. How do you figure out why?',
      'How would you design a URL shortener? Start simple and tell me where it breaks at scale.',
      'Tell me about a technical decision you made that you would do differently now.',
      'A teammate\'s pull request works but you think the design is wrong. What do you do?',
      'How do you decide what to test, and what not to test?',
      'Explain the difference between a process and a thread, and when it matters in practice.',
      'Tell me about a time you had to learn a new language or framework fast to ship something.',
    ],
  },
  {
    id: 'hardware-eng',
    match: /\b(mechanical|electrical|civil|chemical|industrial|manufacturing|aerospace|biomedical|structural|hvac|controls|embedded)\w*\b/i,
    interviewer: 'a senior engineer and hiring manager who signs off on designs and root-cause reports',
    topics: 'design trade-offs, tolerances and safety factors, root-cause analysis, codes and standards, CAD and simulation tools, testing and validation, working with manufacturing and vendors, project constraints (cost, schedule), safety',
    questions: [
      'Walk me through a design you worked on. What constraints drove the biggest decisions?',
      'A part is failing in the field at three times the expected rate. How do you run the root-cause investigation?',
      'How do you choose a safety factor, and when would you push back on one?',
      'Tell me about a time your test results disagreed with your analysis. What did you do?',
      'Manufacturing says your design is too expensive to build. How do you respond?',
      'Which codes or standards matter most in this field, and how have you applied one?',
      'Tell me about a mistake in a calculation or drawing that you caught, or missed.',
    ],
  },
  {
    id: 'healthcare',
    match: /\b(nurs|rn\b|lpn|cna|medical|clinical|clinic|hospital|patient|physician|doctor|pharmac|therap|paramedic|emt|dental|health|caregiver|radiolog|phlebotom|surgical)\w*\b/i,
    interviewer: 'a nurse manager and clinical hiring lead on a busy hospital unit',
    topics: 'patient safety and prioritisation, clinical judgement and escalation, scope of practice, handoffs and documentation, infection control, HIPAA and privacy, difficult patients and families, teamwork with physicians, medication safety, stress on long shifts',
    questions: [
      'You have four patients and two call lights go off while a third patient\'s vitals are dropping. Who do you see first, and why?',
      'Tell me about a time you noticed something was wrong with a patient before anyone else did.',
      'A physician gives you an order you believe is unsafe. What do you do?',
      'Walk me through a good shift handoff. What must never be left out?',
      'A family member is yelling at you at the nurses\' station. How do you handle it?',
      'Tell me about a mistake you made or nearly made in patient care, and what you changed afterward.',
      'How do you protect patient privacy when a friend of a patient asks you for an update?',
      'How do you take care of yourself after a really hard shift?',
    ],
  },
  {
    id: 'education',
    match: /\b(teach|teacher|tutor|professor|instructor|educat|school|classroom|curriculum|coach|mentor|paraprofessional|counselor)\w*\b/i,
    interviewer: 'a school principal who hires teachers and observes classrooms',
    topics: 'lesson planning, classroom management, differentiation for different learners, assessment, working with parents, student safety and mandated reporting, engaging reluctant students, using technology, collaborating with colleagues',
    questions: [
      'Walk me through how you would teach a lesson on a topic you know well to a class with very mixed levels.',
      'A student refuses to do any work and is distracting others. What do you do in the moment, and afterward?',
      'How do you know a lesson actually worked?',
      'A parent emails angry about a grade you gave. How do you respond?',
      'Tell me about a student you struggled to reach. What finally worked, or what would you try now?',
      'How would you support a student with an IEP in a general classroom?',
      'Tell me about a lesson that flopped. What did you change?',
    ],
  },
  {
    id: 'finance',
    match: /\b(financ|accountant|accounting|audit|tax|bank|banking|investment|actuar|bookkeep|controller|treasury|credit|underwrit|payroll|cpa)\w*\b/i,
    interviewer: 'a finance manager who reviews models, reconciliations and audit findings',
    topics: 'the three financial statements and how they link, reconciliations, accruals, Excel modelling, valuation basics, internal controls, attention to detail, deadlines at month-end, explaining numbers to non-finance people, ethics',
    questions: [
      'Walk me through how a hundred dollars of depreciation flows through the three financial statements.',
      'Your reconciliation is off by twelve hundred dollars the night before close. What do you do?',
      'Tell me about a time you caught an error in someone else\'s numbers. How did you raise it?',
      'How would you explain a drop in gross margin to a sales manager with no finance background?',
      'A manager asks you to book revenue a few days early to hit the quarter. How do you respond?',
      'Walk me through a spreadsheet or model you built. How did you check it was right?',
      'What is working capital, and why would a profitable company still run out of cash?',
    ],
  },
  {
    id: 'sales-marketing',
    match: /\b(sales|account executive|account manager|business development|bdr|sdr|marketing|brand|social media|content|seo|advertis|public relations|pr\b|communications|growth|recruit)\w*\b/i,
    interviewer: 'a sales and marketing director who has carried a quota and run campaigns',
    topics: 'prospecting and pipeline, discovery questions, handling objections, closing, campaign planning and metrics (CAC, conversion, ROI), audience and positioning, content and channels, CRM hygiene, rejection and resilience, cross-team work',
    questions: [
      'Sell me this interview slot. Why should I give it to you and not the next candidate?',
      'A prospect says your product is too expensive. What do you say next?',
      'Walk me through a campaign or project you ran. How did you measure whether it worked?',
      'You are at sixty percent of your target with two weeks left in the quarter. What is your plan?',
      'How would you figure out who our ideal customer is?',
      'Tell me about a deal, pitch, or idea that was rejected. What did you learn?',
      'Which marketing channel would you cut first if our budget were halved, and why?',
    ],
  },
  {
    id: 'product-project',
    match: /\b(product manager|product owner|project manager|program manager|pm\b|scrum|agile|operations|ops manager|coordinator|consultant|business analyst)\w*\b/i,
    interviewer: 'a director of product and operations who hires PMs and coordinators',
    topics: 'prioritisation frameworks, scoping and trade-offs, stakeholder management, timelines and risk, metrics, writing requirements, running meetings, saying no, handling scope creep, cross-functional conflict',
    questions: [
      'You have three urgent requests from three executives and room for one. How do you decide?',
      'Tell me about a project that slipped. When did you know, and what did you do?',
      'How would you measure whether a new feature is successful?',
      'Engineering says the deadline is impossible. Sales already promised it to a customer. What do you do?',
      'Walk me through how you would write the requirements for a simple feature, like password reset.',
      'Tell me about a time you had to say no to a stakeholder.',
      'How do you run a meeting that actually ends with decisions?',
    ],
  },
  {
    id: 'design',
    match: /\b(design|designer|ux|ui|user experience|graphic|illustrat|creative|art director|animator|video|photograph)\w*\b/i,
    interviewer: 'a design lead who runs portfolio reviews and critiques',
    topics: 'design process, user research, portfolio walkthroughs, handling critique, accessibility, design systems, working with developers, trade-offs between aesthetics and usability, tools',
    questions: [
      'Walk me through one project in your portfolio, from the problem to the final design.',
      'How do you know a design is good, beyond your own taste?',
      'A developer says your design is too hard to build in time. What do you do?',
      'Tell me about feedback on your work that stung. What did you do with it?',
      'How do you make a design accessible to someone using a screen reader?',
      'The client wants the logo bigger for the fourth time. How do you handle it?',
    ],
  },
  {
    id: 'service',
    match: /\b(customer|retail|cashier|server|barista|host|hospitality|restaurant|hotel|chef|cook|kitchen|line cook|front desk|receptionist|call center|store|shift|warehouse|driver|delivery)\w*\b/i,
    interviewer: 'a store and operations manager who hires front-line staff',
    topics: 'handling difficult customers, working fast under pressure, teamwork on a shift, reliability and attendance, cash handling and honesty, following procedures, upselling, safety, prioritising many tasks at once',
    questions: [
      'A customer is yelling that their order is wrong and the line is ten people deep. What do you do?',
      'Tell me about a time you went above and beyond for a customer.',
      'You see a coworker taking money from the register. What do you do?',
      'It is the dinner rush and you are short two people. How do you prioritise?',
      'Your manager asks you to stay late on a night you have plans. How do you handle it?',
      'How would you handle a customer asking for a refund that is against our policy?',
    ],
  },
  {
    id: 'trades',
    match: /\b(electrician|plumb|hvac tech|mechanic|technician|welder|carpent|construction|maintenance|machinist|lineman|installer)\w*\b/i,
    interviewer: 'a shop foreman and hiring manager who has done the work for twenty years',
    topics: 'safety procedures (lockout/tagout, PPE), troubleshooting, reading drawings and specs, codes, tools and equipment, working with customers on site, quality and rework, reliability, teamwork on a crew',
    questions: [
      'Walk me through how you troubleshoot a job when the obvious fix did not work.',
      'Tell me about a time you stopped a job because something was not safe.',
      'A customer wants you to skip a step that code requires to save money. What do you say?',
      'How do you make sure your work passes inspection the first time?',
      'Tell me about a mistake on a job and how you fixed it.',
      'Which tool or piece of equipment are you best with, and what can go wrong with it?',
    ],
  },
];

// First match wins. Specific before broad: "Financial Analyst" is finance, not data;
// "Mechanical Engineer" is hardware, not software; "IT Security Analyst" is security.
const ORDER = ['security', 'it', 'legal', 'finance', 'sales-marketing', 'data', 'hardware-eng', 'software', 'healthcare', 'education', 'product-project', 'design', 'service', 'trades'];
export const TRACKS = ORDER.map((id) => TRACK_LIST.find((t) => t.id === id));
const matches = (track, text) => [].concat(track.match).some((re) => re.test(text));

const GENERAL = {
  id: 'general',
  interviewer: 'the hiring manager for this role, someone who has done this job and knows what great looks like',
  topics: 'the day-to-day tasks of this job, the skills and tools it needs, realistic situations from the job, working with a team and a manager, handling pressure and mistakes, motivation for this specific role',
  questions: [
    'What do you think the first ninety days in this {role} job look like, and how would you spend them?',
    'Which skill matters most for a {role}, and how have you shown it?',
    'Tell me about a situation from work, school, or volunteering that is most like what a {role} deals with.',
    'What is the hardest part of being a {role}, and how would you handle it?',
    'Tell me about a mistake you made that taught you something useful for this job.',
    'How would your last manager or teacher describe the way you work?',
  ],
};

// Behavioral questions phrased for the role, used after the track's own questions run out.
const BEHAVIORAL = [
  'Tell me about a time you failed at something that matters for a {role}. What happened?',
  'Why should we hire you over the other {role} candidates?',
  'Describe a conflict with a teammate and how you handled it.',
  'Tell me about a time you had to learn something new very quickly for work or school.',
  'Describe a decision you made with incomplete information. How did it turn out?',
  'Tell me about a time you missed a deadline. What would you do differently?',
  'How do you handle feedback you think is wrong?',
  'Why this {role} role, and why now?',
  'Where do you see yourself in five years?',
  'Is there anything you want me to know about you that we have not covered?',
];

// Picks the track by the role title first; the job details only break a tie when the title is vague.
export function pickTrack(role, jobDetails = '') {
  const byTitle = TRACKS.find((t) => matches(t, ` ${role} `));
  if (byTitle) return byTitle;
  const byDetails = jobDetails ? TRACKS.find((t) => matches(t, ` ${jobDetails.slice(0, 600)} `)) : null;
  return byDetails || GENERAL;
}

const fill = (q, role) => q.replaceAll('{role}', role);

export function openerFor(role) {
  return `Hi, thanks for coming in to interview for the ${role} position. Let's start simple: tell me about yourself and what draws you to this role.`;
}

// Ordered fallback questions for this role: track-specific first, then behavioral.
export function roleQuestions(role, jobDetails = '') {
  const track = pickTrack(role, jobDetails);
  const specific = track === GENERAL ? GENERAL.questions : [...track.questions, ...GENERAL.questions.slice(0, 2)];
  return [...specific, ...BEHAVIORAL].map((q) => fill(q, role));
}

// Everything interviewer.js needs to brief Gemini.
export function roleBrief(role, jobDetails = '') {
  const track = pickTrack(role, jobDetails);
  return { role, jobDetails, track: track.id, interviewer: track.interviewer, topics: track.topics, seniority: seniorityOf(role) };
}
