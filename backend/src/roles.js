// Role tailoring: whatever the candidate types in the "Role" box (plus an optional job posting)
// decides who the interviewer is and what it asks.
//
// - Gemini on: interviewer.js puts the role, the job details and the matching "track" below into the
//   system prompt, so Gemini plays the hiring manager for that exact job.
// - There is no canned fallback: if Gemini fails, the interview shows the error (see interviewer.js).

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

// Each track: how to recognise it, who the interviewer is, and what a real interviewer digs into.
const TRACK_LIST = [
  {
    id: 'legal',
    match: /\b(paralegal|attorney|lawyer|legal|law clerk|counsel|compliance|contracts? (manager|specialist|administrator))\w*\b/i,
    interviewer: 'a supervising attorney who hires paralegals, clerks and associates',
    topics: 'legal research and citing sources, drafting and proofreading documents, deadlines and docketing, confidentiality and privilege, conflicts of interest, client communication, managing many matters at once, ethics, attention to detail',
  },
  {
    id: 'security',
    match: /\b(cyber|security|infosec|soc\b|pentest|penetration|red team|blue team|threat|incident response|grc|forensic|vulnerab|appsec)\w*\b/i,
    interviewer: 'a security operations lead who has run incident response and hires analysts and engineers',
    topics: 'triaging alerts and false positives, incident response steps, common attacks (phishing, credential stuffing, ransomware, lateral movement), logs and SIEM queries, network fundamentals, least privilege and IAM, vulnerability management and patch priority, frameworks like NIST and MITRE ATT&CK, explaining risk to non-technical people, ethics and scope',
  },
  {
    id: 'it',
    match: [/\bIT\b/, /\b(help ?desk|service desk|desktop support|tech support|technical support|sys ?admin|system administrator|network|infrastructure|cloud|devops|sre|site reliability|administrator)\w*\b/i],
    interviewer: 'an IT infrastructure manager who has worked the help desk and the server room',
    topics: 'troubleshooting methodology, Active Directory and user accounts, networking (DNS, DHCP, VLANs, VPN), Windows and Linux administration, backups and recovery, ticket prioritisation, documentation, scripting and automation, change management, outages and on-call, dealing with frustrated users',
  },
  {
    id: 'data',
    match: /\b(data|analyst|analytics|machine learning|ml|ai engineer|scientist|statistic|bi |business intelligence|quant)\w*\b/i,
    interviewer: 'a data science manager who reviews analyses and models for production',
    topics: 'SQL and data cleaning, experiment design and A/B tests, statistics intuition, choosing metrics, bias and leakage, model evaluation, communicating findings to stakeholders, dashboards, messy real-world data',
  },
  {
    id: 'software',
    match: /\b(software|developer|engineer|engineering|programmer|coder|front ?end|back ?end|full ?stack|web|mobile|ios|android|swe|qa|test automation|game dev)\w*\b/i,
    interviewer: 'an engineering manager who still reviews code and runs technical interviews',
    topics: 'debugging a real bug, design trade-offs, data structures and complexity at a practical level, APIs and databases, testing, code review, version control, scaling and performance, reading unfamiliar code, estimating and shipping, working with product and design',
  },
  {
    id: 'hardware-eng',
    match: /\b(mechanical|electrical|civil|chemical|industrial|manufacturing|aerospace|biomedical|structural|hvac|controls|embedded)\w*\b/i,
    interviewer: 'a senior engineer and hiring manager who signs off on designs and root-cause reports',
    topics: 'design trade-offs, tolerances and safety factors, root-cause analysis, codes and standards, CAD and simulation tools, testing and validation, working with manufacturing and vendors, project constraints (cost, schedule), safety',
  },
  {
    id: 'healthcare',
    match: /\b(nurs|rn\b|lpn|cna|medical|clinical|clinic|hospital|patient|physician|doctor|pharmac|therap|paramedic|emt|dental|health|caregiver|radiolog|phlebotom|surgical)\w*\b/i,
    interviewer: 'a nurse manager and clinical hiring lead on a busy hospital unit',
    topics: 'patient safety and prioritisation, clinical judgement and escalation, scope of practice, handoffs and documentation, infection control, HIPAA and privacy, difficult patients and families, teamwork with physicians, medication safety, stress on long shifts',
  },
  {
    id: 'education',
    match: /\b(teach|teacher|tutor|professor|instructor|educat|school|classroom|curriculum|coach|mentor|paraprofessional|counselor)\w*\b/i,
    interviewer: 'a school principal who hires teachers and observes classrooms',
    topics: 'lesson planning, classroom management, differentiation for different learners, assessment, working with parents, student safety and mandated reporting, engaging reluctant students, using technology, collaborating with colleagues',
  },
  {
    id: 'finance',
    match: /\b(financ|accountant|accounting|audit|tax|bank|banking|investment|actuar|bookkeep|controller|treasury|credit|underwrit|payroll|cpa)\w*\b/i,
    interviewer: 'a finance manager who reviews models, reconciliations and audit findings',
    topics: 'the three financial statements and how they link, reconciliations, accruals, Excel modelling, valuation basics, internal controls, attention to detail, deadlines at month-end, explaining numbers to non-finance people, ethics',
  },
  {
    id: 'sales-marketing',
    match: /\b(sales|account executive|account manager|business development|bdr|sdr|marketing|brand|social media|content|seo|advertis|public relations|pr\b|communications|growth|recruit)\w*\b/i,
    interviewer: 'a sales and marketing director who has carried a quota and run campaigns',
    topics: 'prospecting and pipeline, discovery questions, handling objections, closing, campaign planning and metrics (CAC, conversion, ROI), audience and positioning, content and channels, CRM hygiene, rejection and resilience, cross-team work',
  },
  {
    id: 'product-project',
    match: /\b(product manager|product owner|project manager|program manager|pm\b|scrum|agile|operations|ops manager|coordinator|consultant|business analyst)\w*\b/i,
    interviewer: 'a director of product and operations who hires PMs and coordinators',
    topics: 'prioritisation frameworks, scoping and trade-offs, stakeholder management, timelines and risk, metrics, writing requirements, running meetings, saying no, handling scope creep, cross-functional conflict',
  },
  {
    id: 'design',
    match: /\b(design|designer|ux|ui|user experience|graphic|illustrat|creative|art director|animator|video|photograph)\w*\b/i,
    interviewer: 'a design lead who runs portfolio reviews and critiques',
    topics: 'design process, user research, portfolio walkthroughs, handling critique, accessibility, design systems, working with developers, trade-offs between aesthetics and usability, tools',
  },
  {
    id: 'service',
    match: /\b(customer|retail|cashier|server|barista|host|hospitality|restaurant|hotel|chef|cook|kitchen|line cook|front desk|receptionist|call center|store|shift|warehouse|driver|delivery)\w*\b/i,
    interviewer: 'a store and operations manager who hires front-line staff',
    topics: 'handling difficult customers, working fast under pressure, teamwork on a shift, reliability and attendance, cash handling and honesty, following procedures, upselling, safety, prioritising many tasks at once',
  },
  {
    id: 'trades',
    match: /\b(electrician|plumb|hvac tech|mechanic|technician|welder|carpent|construction|maintenance|machinist|lineman|installer)\w*\b/i,
    interviewer: 'a shop foreman and hiring manager who has done the work for twenty years',
    topics: 'safety procedures (lockout/tagout, PPE), troubleshooting, reading drawings and specs, codes, tools and equipment, working with customers on site, quality and rework, reliability, teamwork on a crew',
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
};

// Picks the track by the role title first; the job details only break a tie when the title is vague.
export function pickTrack(role, jobDetails = '') {
  const byTitle = TRACKS.find((t) => matches(t, ` ${role} `));
  if (byTitle) return byTitle;
  const byDetails = jobDetails ? TRACKS.find((t) => matches(t, ` ${jobDetails.slice(0, 600)} `)) : null;
  return byDetails || GENERAL;
}

// Everything interviewer.js needs to brief Gemini.
export function roleBrief(role, jobDetails = '') {
  const track = pickTrack(role, jobDetails);
  return { role, jobDetails, track: track.id, interviewer: track.interviewer, topics: track.topics, seniority: seniorityOf(role) };
}
