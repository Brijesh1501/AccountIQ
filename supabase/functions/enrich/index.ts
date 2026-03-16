// AccountIQ — Supabase Edge Function (Groq + Web Search + LinkedIn scrape)
// File: supabase/functions/enrich/index.ts
// Deploy:  supabase functions deploy enrich --no-verify-jwt
// Secrets: supabase secrets set GROQ_API_KEY=gsk_...
//          supabase secrets set SERPER_API_KEY=...  (free at serper.dev - 2500/month free)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RATE_LIMIT = 100;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + 3600_000 });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  if (entry.count >= RATE_LIMIT) return { allowed: false, remaining: 0 };
  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

// ── Step 1: Search for LinkedIn URL via Serper ──────────────
async function findLinkedInUrl(companyName: string, website: string, serperKey: string): Promise<string> {
  try {
    const query = `${companyName} site:linkedin.com/company`;
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) {
      console.log("Serper LinkedIn search failed:", res.status, "— falling back to Groq");
      return "";
    }
    const data = await res.json();
    for (const item of data?.organic || []) {
      const link: string = item.link || "";
      if (link.includes("linkedin.com/company/")) {
        const match = link.match(/(https:\/\/[a-z]+\.linkedin\.com\/company\/[a-zA-Z0-9_-]+)/);
        if (match) return match[1];
      }
    }
    const kg = data?.knowledgeGraph;
    if (kg?.website) {
      const kgLink = kg.website;
      if (kgLink.includes("linkedin.com/company/")) return kgLink;
    }
    return "";
  } catch (e) {
    console.error("Serper search error:", e);
    return "";
  }
}

// ── Step 2: Scrape LinkedIn public page ─────────────────────
interface LinkedInData {
  employeeCount: string;
  employeeRange: string;
  hqLocation: string;
  founded: string;
  industry: string;
  companyType: string;
  website: string;
  about: string;
  engineeringTeamSize: string;
  devOpsTeamSize: string;
}

async function scrapeLinkedIn(linkedinUrl: string): Promise<LinkedInData> {
  const empty: LinkedInData = { employeeCount: "", employeeRange: "", hqLocation: "", founded: "", industry: "", companyType: "", website: "", about: "", engineeringTeamSize: "", devOpsTeamSize: "" };
  try {
    const res = await fetch(linkedinUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });
    if (!res.ok) { console.log("LinkedIn fetch status:", res.status); return empty; }

    const html = await res.text();

    const empRangeMatch = html.match(/(\d[\d,]*[-]\d[\d,]*)\s*employees/i) ||
                          html.match(/"staffCount"\s*:\s*(\d+)/i) ||
                          html.match(/(\d[\d,]+)\s*employees/i);
    const employeeRange = empRangeMatch ? empRangeMatch[1].replace(/,/g, "") : "";

    const staffMatch = html.match(/"numberOfEmployees"[^}]*"value"\s*:\s*(\d+)/) ||
                       html.match(/"staffCount"\s*:\s*(\d+)/);
    const employeeCount = staffMatch ? staffMatch[1] : "";

    const hqMatch = html.match(/"addressLocality"\s*:\s*"([^"]+)"/) ||
                    html.match(/"addressCountry"\s*:\s*"([^"]+)"/);
    const hqLocation = hqMatch ? hqMatch[1].trim() : "";

    const foundedMatch = html.match(/[Ff]ounded\s*[:\s]*(\d{4})/) ||
                         html.match(/"foundingDate"\s*:\s*"(\d{4})"/);
    const founded = foundedMatch ? foundedMatch[1] : "";

    const aboutMatch = html.match(/<meta\s+name="description"\s+content="([^"]{50,500})"/i);
    const about = aboutMatch ? aboutMatch[1].trim() : "";

    const typeMatch = html.match(/[Cc]ompany [Tt]ype[^:]{0,20}:\s*([^<]{1,50})/);
    const companyType = typeMatch ? typeMatch[1].trim() : "";

    const engMatch = html.match(/Engineering[^<]{0,50}(\d[\d,]+)\s*(?:employees?|members?)/i) ||
                     html.match(/(\d[\d,]+)\s*(?:employees?|members?)[^<]{0,30}Engineering/i) ||
                     html.match(/"Engineering"\s*[^}]{0,100}"memberCount"\s*:\s*(\d+)/i);
    const engineeringTeamSize = engMatch ? engMatch[1].replace(/,/g, "") : "";

    const devopsMatch = html.match(/DevOps[^<]{0,50}(\d[\d,]+)\s*(?:employees?|members?)/i) ||
                        html.match(/Infrastructure[^<]{0,50}(\d[\d,]+)\s*(?:employees?|members?)/i) ||
                        html.match(/"DevOps"\s*[^}]{0,100}"memberCount"\s*:\s*(\d+)/i);
    const devOpsTeamSize = devopsMatch ? devopsMatch[1].replace(/,/g, "") : "";

    return { employeeCount, employeeRange, hqLocation, founded, industry: "", companyType, website: "", about, engineeringTeamSize, devOpsTeamSize };
  } catch (e) {
    console.error("LinkedIn scrape error:", e);
    return empty;
  }
}

// ── Step 3: Search for extra company info ───────────────────
async function searchCompanyInfo(companyName: string, website: string, serperKey: string): Promise<string> {
  try {
    const query = `${companyName} ${website} company headquarters employees revenue`;
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) {
      console.log("Serper company search failed:", res.status, "— falling back to Groq");
      return "";
    }
    const data = await res.json();
    const snippets: string[] = [];
    const kg = data?.knowledgeGraph;
    if (kg?.description) snippets.push("About: " + kg.description);
    if (kg?.attributes) {
      for (const [k, v] of Object.entries(kg.attributes)) {
        snippets.push(`${k}: ${v}`);
      }
    }
    for (const item of (data?.organic || []).slice(0, 4)) {
      if (item.snippet) snippets.push(item.snippet);
    }
    if (data?.answerBox?.answer) snippets.push(data.answerBox.answer);
    if (data?.answerBox?.snippet) snippets.push(data.answerBox.snippet);
    return snippets.join("\n").slice(0, 2000);
  } catch (e) {
    console.error("Company search error:", e);
    return "";
  }
}

// ═══════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Built from AccountIQ Knowledge Base v2
// ═══════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are an expert B2B account research analyst trained on a specific internal knowledge base. You must follow ALL classification rules below exactly. Use real LinkedIn/web data when provided. Fall back to confident inference when data is missing — never return "Unknown" if inference is possible.

════════════════════════════════════════════════════════════
ACCOUNT TYPE — Apply EXACTLY ONE using this decision tree
════════════════════════════════════════════════════════════

STEP 1 — Is it a PE/VC Firm?
→ Invests capital in businesses rather than selling products/services to end customers
→ Private Equity (PE): invests in mature/established companies, often acquires majority/controlling stakes, focuses on long-term value creation
→ Venture Capital (VC): invests in early-stage or growth-stage startups, takes minority ownership stakes, focuses on innovation and scalability
→ If YES → Account Type = PE/VC Firms. STOP.

STEP 2 — Is it an Agency/Service Company?
→ PRIMARY offering is IT services: IT consulting, app development, website development, digital transformation services
→ Does NOT own a proprietary software product as its core business
→ CRITICAL: Any non-IT service organization (e.g., accounting firm, law firm, marketing agency) → classify as Enterprise, NOT Agency/Service Company
→ If YES → Account Type = Agency/Service Company. STOP.

STEP 3 — Is it an ISV (Independent Software Vendor)?
→ Owns and develops its own software product or platform
→ Provides software to businesses or individual users via subscriptions, licensing, or trial-to-paid models
→ Core business is the SOFTWARE PRODUCT itself, not services
→ MUST be independent: if acquired by another organization → NOT an ISV
→ Revenue model: SaaS subscriptions, software licenses, usage-based billing
→ Examples: Freshworks, Zoho, Postman — own products, independent
→ If YES → Account Type = ISV. STOP.

STEP 4 — Is it a Consumer Portal?
→ ROI primarily dependent on online platforms, NOT offline stores/distributors
→ Operates as a marketplace: connects buyers and sellers
→ Revenue from online transactions, commissions, advertisements, or platform usage fees
→ CRITICAL DISTINCTION: If an organization sells ONLY ITS OWN products via its own website/app → NOT a Consumer Portal → classify as Enterprise
→ Example of what is NOT a Consumer Portal: wildcraft.com (sells own products)
→ Examples of Consumer Portals: Amazon (marketplace), MakeMyTrip (OTA marketplace), TripJack (OTA marketplace)
→ If YES → Account Type = Consumer Portal. STOP.

STEP 5 — Default to Enterprise:
→ Large employee size (generally 1000+ employees)
→ OR smaller organization (~45+ employees) WITH multiple business lines and sub-businesses
→ Can be technology or non-technology based
→ Operates across multiple domains, sub-businesses, or business lines
→ ROI/profitability mainly driven by OFFLINE channels: physical stores, distributors, direct sales
→ Organizations selling their OWN products via website/app → Enterprise (not Consumer Portal)
→ Examples: tejasnetworks.com, wforwoman.com, wildcraft.com
→ Account Type = Enterprise.

════════════════════════════════════════════════════════════
BUSINESS TYPE — Apply exactly one
════════════════════════════════════════════════════════════
B2B: Sells to other businesses/organizations. Characteristics: larger deal sizes, longer sales cycles, relationship-driven sales, customized solutions. Common in: enterprise software, consulting, industrial manufacturing, logistics, IT services. Revenue models: contracts, SaaS subscriptions, licensing, consulting fees.

B2C: Sells directly to individual consumers. Characteristics: large number of customers, shorter purchase decisions, strong focus on marketing/branding. Common in: retail, e-commerce, food & beverage, entertainment, travel. Revenue models: product sales, subscriptions, advertising, transaction fees.

B2B and B2C: Serves both businesses and individual consumers (e.g., a cloud platform that sells to enterprises AND has individual developer plans).

════════════════════════════════════════════════════════════
ACCOUNT SIZE — Based on employee count
════════════════════════════════════════════════════════════
StartUp: fewer than 50 employees
Small: 50–200 employees
Medium: 200–500 employees
Large: 500–1,000 employees
X-Large: 1,000–5,000 employees
XX-Large: 5,000+ employees

PRIORITY: Use LinkedIn employee count/range if provided — it is the most reliable signal.

════════════════════════════════════════════════════════════
INDUSTRIES & SUB-INDUSTRIES — Use exact taxonomy
════════════════════════════════════════════════════════════
Media & Entertainment
  → Broadcasters | Studios & Content Owners | OTT Platforms | Content Syndicators & Distributors | Publishing | General Entertainment Content | News | Gaming | Radio & Music | Cookery Media

Financial Services
  → Retail & Commercial Banking | Investment Management | Insurance | Wealth Management | Payments | NBFC/Lending | Accounting | Others (Fintech & Capital Markets)

Healthcare & Life Sciences
  → Pharmaceuticals | Healthcare Providers | Health, Wellness & Fitness | Medical Devices

Travel & Hospitality
  → Air Travel | Aerospace | Hotels | OTA (Online Travel Agencies)

Business Software / Internet (SaaS)
  → AdTech & MarTech | ERP & Procurement Platforms | AI Platforms & Chatbots | HRMS & Workforce Management | Data Management & Analytics | Cybersecurity Platforms | Inventory Management | Facility Management | CMS | RegTech | Legal Services Platforms | Other B2B SaaS

Sports → Leagues | Clubs & Teams | Sports Federations

Wagering → Gambling Facilities & Casinos | Operators | iGaming | Lotteries | Platform Providers

Retail → E-Commerce

Agriculture, Resources & Utilities → Oil & Energy | Mining | Power & Utilities | Agriculture & AgriTech

Business Services → IT Services & Consulting | BPM/BPO Companies | Marketing & Advertising | Tax, Audit & Legal Services | Translation & Localization

Government & Public Sector → Government & Public Sector
Telecom → Telecom
Industrial & Manufacturing → Industrial & Manufacturing
Automobile → Automobile
Food & Beverage → Food & Beverage
FMCG & CPG → FMCG & CPG
Real Estate → Real Estate
PE/VC Firms → PE/VC Firms
Animation & Gaming → Animation & Gaming
Internet (Digital Platforms) → Internet (Digital Platforms)
Spiritual → Spiritual
Others → Others

════════════════════════════════════════════════════════════
REGIONS
════════════════════════════════════════════════════════════
North America | EMEA | APAC | LATAM | India
Note: India is its own region (not APAC) for this classification.

════════════════════════════════════════════════════════════
CLOUD PLATFORM
════════════════════════════════════════════════════════════
Single platform: AWS | Azure | GCP | Oracle Cloud | IBM Cloud | Alibaba Cloud | DigitalOcean | Cloudflare | Vercel | Netlify | Heroku | On-premise
Multi-cloud: Use format "Multi-cloud (AWS, GCP)" listing specific platforms

Inference rules when not explicitly known:
- Indian startups / SaaS → AWS or GCP
- Travel portals / OTAs → AWS
- Microsoft-stack companies → Azure
- Chinese companies → Alibaba Cloud
- Government / regulated → On-premise or Azure
- Cloud-native SaaS → AWS or GCP

════════════════════════════════════════════════════════════
ENGINEERING & DEVOPS — Format with team size
════════════════════════════════════════════════════════════
Both engineeringIT and devOps MUST combine tech/tools with team size:
  engineeringIT: "[Tech Stack] | Team Size: [number or range]"
  devOps:        "[Tools & Practices] | Team Size: [number or range]"

Engineering team size estimation (% of total employees):
- Pure tech/SaaS company: 50–70%
- Travel/e-commerce: 20–40%
- IT services/consulting: 60–80%
- FMCG/Retail/non-tech: 5–15%
- Media/entertainment: 15–25%
- Fintech: 35–55%

DevOps team size estimation (% of engineering team):
- Modern SaaS / cloud-native: 10–20% of engineering
- Enterprise / traditional: 5–10% of engineering

Tech stack inference by industry:
- Travel portals / OTAs: React, Node.js, Python, Java microservices, REST APIs, Redis, PostgreSQL
- Fintech / payments: Java, Python, Go, Kafka, PostgreSQL, Redis, microservices
- SaaS / B2B software: React, Node.js, Python, REST/GraphQL APIs, PostgreSQL or MongoDB
- E-commerce / retail: React/Next.js, Node.js, Magento or Shopify stack, Python
- Media / OTT: React, Node.js, CDN infrastructure, video streaming tech, Python
- IT services: Java, .NET, Python, various client tech stacks
- Healthcare: Java, Python, HL7/FHIR integrations, secure cloud

DevOps inference by company type:
- Modern startup/SaaS: GitHub Actions, Docker, Kubernetes, Terraform, CI/CD
- Scale-up: Jenkins or GitHub Actions, Docker, Kubernetes, Terraform, monitoring stack
- Enterprise/traditional: Jenkins, Ansible, Docker, on-premise or hybrid K8s
- IT services: Jenkins, Ansible, client-specific tooling

════════════════════════════════════════════════════════════
LOCATION INFERENCE RULES
════════════════════════════════════════════════════════════
- .in domain → India
- .com.au → Australia (APAC)
- .co.uk / .uk → United Kingdom (EMEA)
- .ae → UAE (EMEA)
- .sg → Singapore (APAC)
- .de → Germany (EMEA)

City → State mapping (India):
Bangalore/Bengaluru → Karnataka
Mumbai → Maharashtra
Delhi/Gurugram/Noida → Haryana / Delhi NCR
Hyderabad → Telangana
Chennai → Tamil Nadu
Pune → Maharashtra
Kolkata → West Bengal
Ahmedabad → Gujarat

Timezone inference:
- India → IST / UTC+5:30
- UK → GMT / UTC+0 (BST/UTC+1 in summer)
- UAE → GST / UTC+4
- Singapore → SGT / UTC+8
- Australia (East) → AEST / UTC+10
- Germany/Europe → CET / UTC+1
- US West → PST / UTC-8
- US East → EST / UTC-5

════════════════════════════════════════════════════════════
REVENUE ESTIMATION GUIDELINES
════════════════════════════════════════════════════════════
Use web search data if available. Otherwise estimate from company stage and size:
- StartUp (<50 employees): $0.5M–$5M USD
- Small (50–200): $5M–$30M USD
- Medium (200–500): $30M–$100M USD
- Large (500–1,000): $100M–$300M USD
- X-Large (1,000–5,000): $300M–$1B USD
- XX-Large (5,000+): $1B+ USD
Adjust upward for high-revenue industries (fintech, e-commerce), downward for nonprofits/NGOs.

════════════════════════════════════════════════════════════
ACCOUNT TYPE REASON — Required evidence-based explanation
════════════════════════════════════════════════════════════
Always provide 1–2 sentences citing SPECIFIC evidence:
- Mention the key signals that led to the classification
- Reference employee count, revenue model, product ownership, or marketplace nature
- For Enterprise: mention offline channels or own-product sales
- For ISV: confirm they own a software product and are independent
- For Consumer Portal: confirm marketplace model
- For Agency: confirm IT services without proprietary product
- For PE/VC: confirm capital investment model

════════════════════════════════════════════════════════════
OUTPUT — All 20 fields required, return ONLY valid JSON
════════════════════════════════════════════════════════════
{
  "accountName": "Official company name",
  "website": "The exact domain provided (e.g. tripjack.com). Do not alter it.",
  "draInsights": "2–3 sentences: what company does, business model, key products/services, market position and differentiators",
  "engineeringIT": "Tech stack AND team size. Format: '[Stack] | Team Size: [n]'. Example: 'React, Node.js, Python, PostgreSQL, AWS | Team Size: 150-200'",
  "cloudPlatform": "Single name or Multi-cloud (X, Y) pattern",
  "devOps": "Tools/practices AND team size. Format: '[Tools] | Team Size: [n]'. Example: 'GitHub Actions, Docker, Kubernetes, Terraform | Team Size: 20-30'",
  "employeeCount": "LinkedIn employee count/range if available, else estimated range",
  "accountTypeBySize": "One of: StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)",
  "accountType": "One of: Enterprise | ISV | Consumer Portal | Agency/Service Company | PE/VC Firms",
  "accountTypeReason": "1–2 sentences of evidence-based reasoning citing specific signals",
  "accountLinkedIn": "Real LinkedIn URL if found, else constructed as https://www.linkedin.com/company/[slug]",
  "businessType": "One of: B2B | B2C | B2B and B2C",
  "industry": "Exactly one industry from taxonomy above",
  "subIndustry": "Exactly one sub-industry from taxonomy above",
  "revenueUSD": "From web search if available, else estimated in USD millions (e.g. '$50M-$100M')",
  "billingCity": "From LinkedIn/search or inferred from domain/company type",
  "billingState": "Derived from city using mapping above",
  "billingCountry": "From LinkedIn/search or inferred from domain TLD",
  "region": "One of: North America | EMEA | APAC | LATAM | India",
  "timeZone": "Derived from country/city e.g. IST / UTC+5:30"
}`;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── 1. Verify JWT ───────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized — please log in" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 2. Rate limit ───────────────────────────────────────
    const { allowed, remaining } = checkRateLimit(user.id);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Max 100 enrichments per hour." }), {
        status: 429, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 3. Parse request ────────────────────────────────────
    const body = await req.json();
    const website: string = body?.website?.trim();
    if (!website) {
      return new Response(JSON.stringify({ error: "website field is required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const groqKey = Deno.env.get("GROQ_API_KEY");
    const serperKey = Deno.env.get("SERPER_API_KEY");

    if (!groqKey) {
      return new Response(JSON.stringify({ error: "API key not configured. Contact your admin." }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 4. Extract company name from website ────────────────
    const companyName = website
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(".")[0]
      .replace(/-/g, " ")
      .trim();

    // ── 5. Parallel: Search LinkedIn URL + Company Info ─────
    let linkedInUrl = "";
    let linkedInData: LinkedInData = { employeeCount: "", employeeRange: "", hqLocation: "", founded: "", industry: "", companyType: "", website: "", about: "", engineeringTeamSize: "", devOpsTeamSize: "" };
    let webSearchContext = "";

    if (serperKey) {
      console.log("Running web search for:", website);
      try {
        const [liUrl, webCtx] = await Promise.all([
          findLinkedInUrl(companyName, website, serperKey),
          searchCompanyInfo(companyName, website, serperKey),
        ]);
        linkedInUrl = liUrl;
        webSearchContext = webCtx;
        console.log("LinkedIn URL found:", linkedInUrl || "none");
        console.log("Web context length:", webSearchContext.length);

        if (linkedInUrl) {
          linkedInData = await scrapeLinkedIn(linkedInUrl);
          console.log("LinkedIn data:", JSON.stringify(linkedInData));
        }
      } catch (searchErr) {
        console.log("Web search failed (possibly quota exhausted) — using Groq knowledge only:", searchErr);
        linkedInUrl = "";
        webSearchContext = "";
      }
    } else {
      console.log("No Serper key configured — using Groq knowledge only");
    }

    // ── 6. Build research context for AI ───────────────────
    const researchContext = [
      linkedInUrl ? `LinkedIn URL: ${linkedInUrl}` : "",
      linkedInData.employeeRange ? `LinkedIn Employee Range: ${linkedInData.employeeRange} employees` : "",
      linkedInData.employeeCount ? `LinkedIn Staff Count: ${linkedInData.employeeCount}` : "",
      linkedInData.engineeringTeamSize ? `LinkedIn Engineering/Tech Team Size: ${linkedInData.engineeringTeamSize} (use in engineeringIT field)` : "",
      linkedInData.devOpsTeamSize ? `LinkedIn DevOps/Infrastructure Team Size: ${linkedInData.devOpsTeamSize} (use in devOps field)` : "",
      linkedInData.hqLocation ? `LinkedIn HQ Location: ${linkedInData.hqLocation}` : "",
      linkedInData.founded ? `Founded: ${linkedInData.founded}` : "",
      linkedInData.about ? `LinkedIn About: ${linkedInData.about}` : "",
      webSearchContext ? `\nWeb Search Results:\n${webSearchContext}` : "",
    ].filter(Boolean).join("\n");

    // ── 7. Call Groq ────────────────────────────────────────
    const looksLikeDomain = website.includes('.');
    const userMessage = `Research this company and return the complete 20-field JSON profile.

${looksLikeDomain ? `Website: ${website}` : `Company Name: ${website}
Note: User typed the company name directly. Find the correct website domain and use it in the website field.`}
Company Name (extracted): ${companyName}

${researchContext ? `=== REAL DATA FROM WEB RESEARCH ===
${researchContext}

Use the above real data to fill fields accurately.
- LinkedIn employee count is the most reliable signal for size classification
- LinkedIn HQ location overrides any inferred location
- LinkedIn About section helps determine account type and business model` : `No web search data available — use your full training knowledge.
Apply the complete knowledge base rules in your system prompt.
Make confident inferences based on domain TLD, company name, industry context.
Never return "Unknown" when inference is possible.`}

CLASSIFICATION REMINDERS (apply decision tree in system prompt):
1. Check PE/VC first → then Agency/IT Services → then ISV → then Consumer Portal → default Enterprise
2. Non-IT service companies (e.g. logistics, retail, healthcare) → Enterprise NOT Agency
3. Company selling only its OWN products online → Enterprise NOT Consumer Portal
4. ISV must own a software product AND be independent (not acquired)
5. For accountTypeReason: cite specific evidence (employee count, revenue model, product ownership, marketplace vs own-products)
6. For Indian companies: region=India (not APAC), timezone=IST/UTC+5:30
7. Always include team size estimates in engineeringIT and devOps fields
8. The "website" field must be exactly: ${website}`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error("Groq error:", errText);
      return new Response(JSON.stringify({ error: "AI service error. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const groqData = await groqRes.json();
    let rawText = groqData?.choices?.[0]?.message?.content || "";

    if (!rawText) {
      return new Response(JSON.stringify({ error: "Empty AI response. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 8. Parse JSON ───────────────────────────────────────
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) rawText = jsonMatch[1];
    else {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");
      if (start !== -1 && end !== -1) rawText = rawText.slice(start, end + 1);
    }

    let enriched: Record<string, string>;
    try {
      enriched = JSON.parse(rawText.trim());
    } catch {
      console.error("JSON parse error. Raw:", rawText);
      return new Response(JSON.stringify({ error: "Failed to parse AI response. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 9. Override with real LinkedIn URL if found ─────────
    if (linkedInUrl && linkedInUrl.includes("linkedin.com/company/")) {
      enriched.accountLinkedIn = linkedInUrl;
    }

    // ── 10. Return ──────────────────────────────────────────
    return new Response(JSON.stringify({ data: enriched, remaining }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json", "X-RateLimit-Remaining": String(remaining) },
    });

  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});