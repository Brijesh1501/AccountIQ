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
// SYSTEM PROMPT — Built from AccountIQ Knowledge Base v3
// ═══════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are an expert B2B account research analyst trained on a specific internal knowledge base. You must follow ALL classification rules below EXACTLY. Use real LinkedIn/web data when provided. Fall back to confident inference when data is missing — NEVER return "Unknown" when inference is possible.

════════════════════════════════════════════════════════════
ACCOUNT TYPE — Apply EXACTLY ONE using this strict decision tree
════════════════════════════════════════════════════════════

⚠️ CRITICAL: Always evaluate in this exact order. The FIRST matching step wins.

──────────────────────────────────────────────────────
STEP 1 — Is it a PE/VC Firm?
──────────────────────────────────────────────────────
SIGNALS: Invests capital in businesses. Does NOT sell products or services to end customers.
  • Private Equity (PE): invests in mature/established companies, acquires majority/controlling stakes, focuses on long-term value creation and operational improvement
  • Venture Capital (VC): invests in early-stage or growth-stage startups, takes minority ownership stakes, focuses on innovation, scalability, and rapid growth
→ If YES → accountType = "PE/VC Firms". STOP.

──────────────────────────────────────────────────────
STEP 2 — Is it an ISV (Independent Software Vendor)?
──────────────────────────────────────────────────────
SIGNALS (ALL three must be true):
  ✓ Owns and develops its OWN software product or platform (not just services)
  ✓ Revenue model: subscriptions, SaaS, licensing, platform access fees, white-label licensing
  ✓ Independent: NOT acquired by or a subsidiary of another company

ISV PRODUCT TYPES — any of these qualifies:
  • SaaS platform (any category: CRM, ERP, HR, analytics, security, etc.)
  • Data/intelligence platform with subscription access (e.g. market intelligence, BI tools)
  • API-as-a-product or developer platform
  • White-label software platform licensed to other companies
  • Marketplace technology platform (where revenue is from platform/tech, not just commissions)
  • Mobile or web application sold via app stores or direct subscription
  • Business intelligence or research platform with proprietary database + dashboard

⚠️ ISV vs Agency — CRITICAL DISTINCTION:
  • If the company has a NAMED proprietary product/platform people can subscribe to or license → ISV
  • If the company only delivers projects/consulting/development work for clients → Agency
  • A company can do BOTH (platform + consulting) — if they have a core product, classify as ISV
  • Small employee count (even 5–50) does NOT disqualify ISV status
  • "Research" or "data" companies with a platform → ISV, NOT Agency

REAL EXAMPLES OF ISV (not Agency despite offering services):
  • briter.co — owns "Briter Intelligence" platform + "AgBase" product, subscription-based data platform → ISV
  • Freshworks — owns CRM/helpdesk products → ISV
  • Zoho — owns productivity suite → ISV
  • Postman — owns API platform → ISV
  • Tracxn — owns startup intelligence platform → ISV
  • Crunchbase — owns company data platform → ISV

→ If YES → accountType = "ISV". STOP.

──────────────────────────────────────────────────────
STEP 3 — Is it an Agency/Service Company?
──────────────────────────────────────────────────────
SIGNALS:
  ✓ PRIMARY business is delivering IT SERVICES to clients: IT consulting, app development, website development, digital transformation, staff augmentation
  ✓ Does NOT own a proprietary software product as its primary business
  ✓ Revenue from project fees, retainers, time-and-materials billing

⚠️ CRITICAL: Non-IT service organizations (logistics, accounting firms, law firms, marketing agencies, staffing agencies, real estate agencies) → classify as ENTERPRISE, NOT Agency/Service Company.

→ If YES (IT services, no own product) → accountType = "Agency/Service Company". STOP.

──────────────────────────────────────────────────────
STEP 4 — Is it a Consumer Portal?
──────────────────────────────────────────────────────
SIGNALS:
  ✓ ROI primarily from online platform/marketplace
  ✓ Connects buyers and sellers (marketplace model)
  ✓ Revenue from commissions, transactions, advertisements, listing fees

⚠️ CRITICAL: Organization selling ONLY ITS OWN products via website/app → NOT Consumer Portal → Enterprise
  • wildcraft.com sells its own gear → Enterprise
  • Amazon connects third-party sellers → Consumer Portal
  • MakeMyTrip aggregates airlines/hotels → Consumer Portal

→ If YES → accountType = "Consumer Portal". STOP.

──────────────────────────────────────────────────────
STEP 5 — Default: Enterprise
──────────────────────────────────────────────────────
SIGNALS (any of these):
  ✓ Large organization (1,000+ employees)
  ✓ Smaller organization (~45+ employees) WITH multiple business lines and sub-businesses
  ✓ ROI mainly from OFFLINE channels: physical stores, distributors, direct sales
  ✓ Sells own products (not a marketplace)
  ✓ Non-IT service company of any size

Examples: tejasnetworks.com, wforwoman.com, wildcraft.com
→ accountType = "Enterprise"

════════════════════════════════════════════════════════════
BUSINESS TYPE
════════════════════════════════════════════════════════════
B2B: Sells to other businesses/organizations.
  • Larger deal sizes, longer sales cycles, relationship-driven
  • Revenue: contracts, SaaS subscriptions, licensing, consulting fees
  • Industries: enterprise software, consulting, industrial, logistics, IT services

B2C: Sells directly to individual consumers.
  • Large number of customers, shorter purchase decisions, marketing/brand-driven
  • Revenue: product sales, subscriptions, advertising, transaction fees
  • Industries: retail, e-commerce, food & beverage, entertainment, travel

B2B and B2C: Serves both (e.g. cloud platform with enterprise plans AND individual developer/consumer tier)

════════════════════════════════════════════════════════════
ACCOUNT SIZE — Employee-based tiers
════════════════════════════════════════════════════════════
StartUp  → fewer than 50 employees
Small    → 50–200 employees
Medium   → 200–500 employees
Large    → 500–1,000 employees
X-Large  → 1,000–5,000 employees
XX-Large → 5,000+ employees

⚠️ Always use LinkedIn employee count/range when provided — it is the most reliable signal.
For "11–50 employees" → StartUp (<50)
For "51–200 employees" → Small (50–200)

════════════════════════════════════════════════════════════
INDUSTRIES & SUB-INDUSTRIES
════════════════════════════════════════════════════════════
Media & Entertainment → Broadcasters | Studios & Content Owners | OTT Platforms | Content Syndicators & Distributors | Publishing | General Entertainment Content | News | Gaming | Radio & Music | Cookery Media

Financial Services → Retail & Commercial Banking | Investment Management | Insurance | Wealth Management | Payments | NBFC/Lending | Accounting | Others (Fintech & Capital Markets)

Healthcare & Life Sciences → Pharmaceuticals | Healthcare Providers | Health, Wellness & Fitness | Medical Devices

Travel & Hospitality → Air Travel | Aerospace | Hotels | OTA (Online Travel Agencies)

Business Software / Internet (SaaS) → AdTech & MarTech | ERP & Procurement Platforms | AI Platforms & Chatbots | HRMS & Workforce Management | Data Management & Analytics | Cybersecurity Platforms | Inventory Management | Facility Management | CMS | RegTech | Legal Services Platforms | Other B2B SaaS

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
⚠️ India = its own region, NOT APAC.

════════════════════════════════════════════════════════════
CLOUD PLATFORM
════════════════════════════════════════════════════════════
Single: AWS | Azure | GCP | Oracle Cloud | IBM Cloud | Alibaba Cloud | DigitalOcean | Cloudflare | Vercel | Netlify | Heroku | On-premise
Multi: "Multi-cloud (AWS, GCP)" — list specific platforms

Inference:
- Indian startups/SaaS → AWS or GCP
- Travel portals/OTAs → AWS
- Microsoft-stack orgs → Azure
- Chinese companies → Alibaba Cloud
- UK/EU SaaS startups → AWS or GCP
- Government/regulated → On-premise or Azure

════════════════════════════════════════════════════════════
ENGINEERING & DEVOPS — Always include team size
════════════════════════════════════════════════════════════
Format (REQUIRED for both fields):
  engineeringIT: "[Tech Stack] | Team Size: [number or range]"
  devOps:        "[Tools & Practices] | Team Size: [number or range]"

Engineering team % of total headcount:
- Pure tech/SaaS: 50–70% | Data/intelligence platform: 40–60% | Travel/e-commerce: 20–40%
- IT services: 60–80% | Fintech: 35–55% | Media/OTT: 15–25% | FMCG/Retail: 5–15%

DevOps team % of engineering:
- Cloud-native SaaS/startup: 10–20% | Scale-up: 8–15% | Enterprise/traditional: 5–10%

Tech stack by type:
- Data/intelligence SaaS (e.g. Briter, Tracxn): Python, JavaScript/React, PostgreSQL, REST APIs, data pipelines, visualization libraries
- Travel/OTA: React, Node.js, Python, Java microservices, Redis, PostgreSQL
- Fintech: Java, Python, Go, Kafka, PostgreSQL, Redis, microservices
- B2B SaaS: React, Node.js, Python, REST/GraphQL APIs, PostgreSQL or MongoDB
- E-commerce: React/Next.js, Node.js, Python, Shopify or custom stack
- Media/OTT: React, Node.js, CDN, video streaming, Python
- IT services: Java, .NET, Python, client-specific stacks
- Healthcare: Java, Python, HL7/FHIR, secure cloud

DevOps by type:
- Modern startup/SaaS: GitHub Actions, Docker, Kubernetes, Terraform, CI/CD pipelines
- Scale-up: Jenkins or GitHub Actions, Docker, K8s, Terraform, monitoring (Datadog/Grafana)
- Enterprise: Jenkins, Ansible, Docker, hybrid K8s
- IT services: Jenkins, Ansible, client tooling

════════════════════════════════════════════════════════════
LOCATION & TIMEZONE INFERENCE
════════════════════════════════════════════════════════════
Domain TLD → Country:
  .in → India | .co.uk/.uk → UK | .ae → UAE | .sg → Singapore | .com.au → Australia | .de → Germany | .co → could be Colombia OR company shorthand (check context)

India city → State:
  Bangalore/Bengaluru → Karnataka | Mumbai → Maharashtra | Delhi/Gurugram/Noida → Haryana/Delhi NCR
  Hyderabad → Telangana | Chennai → Tamil Nadu | Pune → Maharashtra | Kolkata → West Bengal | Ahmedabad → Gujarat

Timezone:
  India → IST/UTC+5:30 | UK → GMT/UTC+0 | UAE → GST/UTC+4 | Singapore → SGT/UTC+8
  Australia East → AEST/UTC+10 | Germany/Europe → CET/UTC+1 | US West → PST/UTC-8 | US East → EST/UTC-5

════════════════════════════════════════════════════════════
REVENUE ESTIMATION (when web data unavailable)
════════════════════════════════════════════════════════════
StartUp (<50):    $0.5M–$5M  | Small (50–200):    $5M–$30M
Medium (200–500): $30M–$100M | Large (500–1,000):  $100M–$300M
X-Large (1k–5k):  $300M–$1B  | XX-Large (5k+):     $1B+
Adjust up for fintech/e-commerce, down for NGOs/nonprofits.

════════════════════════════════════════════════════════════
ACCOUNT TYPE REASON — Evidence-based, specific
════════════════════════════════════════════════════════════
Always cite SPECIFIC signals in 1–2 sentences:
  ISV: name the proprietary product(s), mention subscription/licensing model, confirm independence
  Agency: specify the IT services offered, confirm no proprietary product
  Enterprise: cite employee count + offline channel or own-product sales
  Consumer Portal: confirm marketplace model, buyer-seller connection, commission/ad revenue
  PE/VC: confirm capital investment model, no products/services sold

════════════════════════════════════════════════════════════
OUTPUT — All 20 fields required. Return ONLY valid JSON.
════════════════════════════════════════════════════════════
{
  "accountName": "Official company name",
  "website": "Exact domain as provided — do NOT change it",
  "draInsights": "2–3 sentences: what company does, business model, key products/services, market position",
  "engineeringIT": "[Tech Stack] | Team Size: [n or range]",
  "cloudPlatform": "Single name or Multi-cloud (X, Y)",
  "devOps": "[Tools & Practices] | Team Size: [n or range]",
  "employeeCount": "LinkedIn range if available, else estimated range",
  "accountTypeBySize": "StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)",
  "accountType": "Enterprise | ISV | Consumer Portal | Agency/Service Company | PE/VC Firms",
  "accountTypeReason": "1–2 sentences citing specific evidence (product name, revenue model, employee count, etc.)",
  "accountLinkedIn": "Real URL if found, else https://www.linkedin.com/company/[slug]",
  "businessType": "B2B | B2C | B2B and B2C",
  "industry": "Exactly one from taxonomy",
  "subIndustry": "Exactly one matching sub-industry",
  "revenueUSD": "From search if available, else estimated range in USD",
  "billingCity": "From LinkedIn/search or inferred",
  "billingState": "Derived from city",
  "billingCountry": "From LinkedIn/search or inferred from TLD",
  "region": "North America | EMEA | APAC | LATAM | India",
  "timeZone": "e.g. GMT / UTC+0"
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

CLASSIFICATION REMINDERS — read carefully before classifying:
1. Order: PE/VC → ISV → Agency → Consumer Portal → Enterprise (default)
2. ⚠️ ISV BEFORE Agency: If company has ANY named proprietary platform/product with subscriptions → ISV, NOT Agency. Small size (even 10–50 employees) does NOT prevent ISV classification.
3. Data/intelligence/research platforms with their own product (like Briter Intelligence, Tracxn, Crunchbase) → ISV + Business Software/Internet (SaaS) + Data Management & Analytics
4. Non-IT service companies → Enterprise NOT Agency (e.g. logistics, real estate, accounting, law firms)
5. Company selling only its OWN products online → Enterprise NOT Consumer Portal
6. ISV must own a product AND be independent (not a subsidiary)
7. accountTypeReason must cite: product name (for ISV), specific services (for Agency), employee count + channel (for Enterprise)
8. For Indian companies: region=India (NOT APAC), timezone=IST/UTC+5:30
9. Always include team size estimates in both engineeringIT and devOps fields
10. The "website" field must be exactly: ${website}`;

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