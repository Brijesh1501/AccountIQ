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
async function findLinkedInUrl(companyName: string, searchAnchor: string, serperKey: string): Promise<string> {
  try {
    const domainSlug = searchAnchor.split(".")[0].toLowerCase(); // "blackbox" from "blackbox.ai"

    // Helper: extract clean LinkedIn company URL from a result link
    function extractLinkedIn(link: string): string {
      const match = link.match(/(https:\/\/[a-z]+\.linkedin\.com\/company\/[a-zA-Z0-9_-]+)/);
      return match ? match[1] : "";
    }

    // Helper: does the LinkedIn slug plausibly belong to our company?
    // e.g. "blackboxaitechnologies" contains "blackbox" ✓
    // e.g. "black-box-corporation" contains "blackbox" — too generic, need tighter check
    function slugMatchesCompany(linkedInUrl: string, title: string, snippet: string): boolean {
      const slug = linkedInUrl.split("/company/")[1]?.toLowerCase() || "";
      const combined = (slug + " " + title + " " + snippet).toLowerCase();
      // Slug starts with or contains domainSlug
      if (slug.startsWith(domainSlug)) return true;
      if (slug.includes(domainSlug)) return true;
      // searchAnchor (full domain) appears in title or snippet
      if (combined.includes(searchAnchor.toLowerCase())) return true;
      return false;
    }

    // ── PASS 1: Search with full domain anchor (most precise) ──
    const pass1Res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
      body: JSON.stringify({ q: `"${searchAnchor}" site:linkedin.com/company`, num: 5 }),
    });
    if (pass1Res.ok) {
      const data = await pass1Res.json();
      // Check knowledge graph first
      const kg = data?.knowledgeGraph;
      if (kg?.website?.includes("linkedin.com/company/")) return kg.website;
      // Check organic results
      for (const item of data?.organic || []) {
        const link: string = item.link || "";
        const liUrl = extractLinkedIn(link);
        if (liUrl) return liUrl; // domain was quoted so any match is safe
      }
    }

    // ── PASS 2: Fallback — search by company name + TLD hint ──
    // e.g. "blackbox AI" linkedin company  (use TLD as context hint)
    const tld = searchAnchor.split(".").slice(1).join("."); // "ai" from "blackbox.ai"
    const tldHint = ["ai", "io", "co", "app", "dev", "tech"].includes(tld) ? tld.toUpperCase() : "";
    const nameQuery = tldHint
      ? `"${companyName}" ${tldHint} site:linkedin.com/company`
      : `"${companyName}" site:linkedin.com/company`;

    const pass2Res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
      body: JSON.stringify({ q: nameQuery, num: 8 }),
    });
    if (pass2Res.ok) {
      const data = await pass2Res.json();
      // Knowledge graph
      const kg = data?.knowledgeGraph;
      if (kg?.website?.includes("linkedin.com/company/")) {
        const liUrl = extractLinkedIn(kg.website);
        if (liUrl && slugMatchesCompany(liUrl, "", "")) return liUrl;
      }
      // Organic — validate each result belongs to our company
      for (const item of data?.organic || []) {
        const link: string = item.link || "";
        const liUrl = extractLinkedIn(link);
        if (liUrl && slugMatchesCompany(liUrl, item.title || "", item.snippet || "")) {
          return liUrl;
        }
      }
      // Last resort: return first LinkedIn result if only one found (likely correct)
      const allLinkedIn = (data?.organic || [])
        .map((i: { link?: string }) => extractLinkedIn(i.link || ""))
        .filter(Boolean);
      if (allLinkedIn.length === 1) return allLinkedIn[0];
    }

    return "";
  } catch (e) {
    console.error("Serper LinkedIn search error:", e);
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
async function searchCompanyInfo(companyName: string, searchAnchor: string, serperKey: string): Promise<string> {
  try {
    // Quote the full domain to anchor results to the right company
    // e.g. "blackbox.ai" company info — NOT generic "blackbox"
    const query = `"${searchAnchor}" company headquarters employees revenue about`;
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

// ── Step 4: Search for cloud platform evidence ──────────────
interface CloudEvidence {
  platform: string;
  sourceUrl: string;
  snippet: string;
}

async function searchCloudPlatform(companyName: string, searchAnchor: string, serperKey: string): Promise<CloudEvidence> {
  const empty: CloudEvidence = { platform: "", sourceUrl: "", snippet: "" };
  try {
    // searchAnchor is already the clean domain e.g. "blackbox.ai", "briter.co"
    const cleanDomain = searchAnchor;
    const domainSlug = cleanDomain.split(".")[0].toLowerCase();

    // Cloud keyword → platform name mapping
    const cloudKeywords: Record<string, string> = {
      "amazon web services": "AWS", "aws.amazon": "AWS", " aws ": "AWS",
      "amazonaws.com": "AWS", "s3.amazonaws": "AWS", "ec2": "AWS",
      "elasticbeanstalk": "AWS", "cloudfront": "AWS",
      "google cloud": "GCP", "googlecloud": "GCP", " gcp ": "GCP",
      "firebase": "GCP", "bigquery": "GCP", "cloud.google": "GCP",
      "microsoft azure": "Azure", "azure.com": "Azure", " azure ": "Azure",
      "azure storage": "Azure", "azure functions": "Azure",
      "digitalocean": "DigitalOcean", "cloudflare": "Cloudflare",
      "heroku": "Heroku", "vercel": "Vercel", "netlify": "Netlify",
      "oracle cloud": "Oracle Cloud", "ibm cloud": "IBM Cloud",
      "alibaba cloud": "Alibaba Cloud",
    };

    function detectPlatform(text: string): string {
      const t = " " + text.toLowerCase() + " ";
      for (const [kw, platform] of Object.entries(cloudKeywords)) {
        if (t.includes(kw)) return platform;
      }
      return "";
    }

    // Strict company match: URL must contain domain slug OR company name
    function isOurCompany(link: string, title: string, snippet: string): boolean {
      const url = link.toLowerCase();
      const content = (title + " " + snippet).toLowerCase();
      // URL contains domain slug (most reliable)
      if (url.includes(domainSlug)) return true;
      // URL is a profile page for our company on a tech site
      const techSites = ["builtwith.com", "wappalyzer.com", "stackshare.io", "crunchbase.com", "linkedin.com"];
      for (const site of techSites) {
        if (url.includes(site) && url.includes(domainSlug)) return true;
      }
      // Content mentions our company domain
      if (content.includes(cleanDomain)) return true;
      return false;
    }

    // ── TIER 1: BuiltWith direct profile ───────────────────
    // builtwith.com/website/briter.co shows exact tech stack
    const builtWithUrl = `https://builtwith.com/website/${cleanDomain}`;
    try {
      const bwRes = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
        body: JSON.stringify({ q: `site:builtwith.com "${cleanDomain}"`, num: 3 }),
      });
      if (bwRes.ok) {
        const bwData = await bwRes.json();
        for (const item of bwData?.organic || []) {
          const link: string = item.link || "";
          if (link.includes("builtwith.com") && link.includes(domainSlug)) {
            const platform = detectPlatform(item.title + " " + item.snippet);
            if (platform) return { platform, sourceUrl: link, snippet: item.snippet || "" };
            // BuiltWith page found but no cloud in snippet — still return URL as best source
            return { platform: "", sourceUrl: link, snippet: item.snippet || "" };
          }
        }
      }
    } catch { /* continue */ }

    // ── TIER 2: Wappalyzer profile ─────────────────────────
    try {
      const wapRes = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
        body: JSON.stringify({ q: `site:wappalyzer.com "${cleanDomain}"`, num: 3 }),
      });
      if (wapRes.ok) {
        const wapData = await wapRes.json();
        for (const item of wapData?.organic || []) {
          const link: string = item.link || "";
          if (link.includes("wappalyzer.com") && link.includes(domainSlug)) {
            const platform = detectPlatform(item.title + " " + item.snippet);
            if (platform) return { platform, sourceUrl: link, snippet: item.snippet || "" };
            return { platform: "", sourceUrl: link, snippet: item.snippet || "" };
          }
        }
      }
    } catch { /* continue */ }

    // ── TIER 3: StackShare profile ──────────────────────────
    try {
      const ssRes = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
        body: JSON.stringify({ q: `site:stackshare.io "${companyName}"`, num: 3 }),
      });
      if (ssRes.ok) {
        const ssData = await ssRes.json();
        for (const item of ssData?.organic || []) {
          const link: string = item.link || "";
          const title: string = item.title || "";
          if (link.includes("stackshare.io") && (link.includes(domainSlug) || title.toLowerCase().includes(companyName.toLowerCase()))) {
            const platform = detectPlatform(title + " " + item.snippet);
            if (platform) return { platform, sourceUrl: link, snippet: item.snippet || "" };
            return { platform: "", sourceUrl: link, snippet: item.snippet || "" };
          }
        }
      }
    } catch { /* continue */ }

    // ── TIER 4: Company careers/jobs page ──────────────────
    try {
      const careersRes = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
        body: JSON.stringify({ q: `site:${cleanDomain} (AWS OR "Google Cloud" OR Azure OR cloud OR infrastructure OR DevOps) (careers OR jobs OR engineering OR tech)`, num: 5 }),
      });
      if (careersRes.ok) {
        const careersData = await careersRes.json();
        for (const item of careersData?.organic || []) {
          const link: string = item.link || "";
          if (link.includes(cleanDomain)) {
            const platform = detectPlatform(item.title + " " + item.snippet);
            if (platform) return { platform, sourceUrl: link, snippet: item.snippet || "" };
          }
        }
      }
    } catch { /* continue */ }

    // ── TIER 5: Company tech blog / about page ──────────────
    try {
      const techBlogRes = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
        body: JSON.stringify({ q: `"${companyName}" AWS OR "Google Cloud" OR Azure tech stack engineering blog`, num: 5 }),
      });
      if (techBlogRes.ok) {
        const blogData = await techBlogRes.json();
        for (const item of blogData?.organic || []) {
          const link: string = item.link || "";
          const title: string = item.title || "";
          const snippet: string = item.snippet || "";
          // Must be about our company
          if (!isOurCompany(link, title, snippet)) continue;
          const platform = detectPlatform(title + " " + snippet);
          if (platform) return { platform, sourceUrl: link, snippet };
        }
      }
    } catch { /* continue */ }

    return empty;
  } catch (e) {
    console.error("Cloud platform search error:", e);
    return empty;
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
StartUp (<50)        → fewer than 50 employees
Small (50 - 200)     → 50–200 employees
Medium (200 - 500)   → 200–500 employees
Large (500 - 1000)   → 500–1,000 employees
X-Large (1000 - 5000) → 1,000–5,000 employees
XX-Large (5000+)     → 5,000+ employees

⚠️ Always use LinkedIn employee count/range when provided — it is the most reliable signal.
LinkedIn range → correct tier mapping (use EXACT label):
  "1-10"        → StartUp (<50)
  "11-50"       → StartUp (<50)     ← 34 employees = StartUp, NOT Small
  "51-200"      → Small (50 - 200)
  "201-500"     → Medium (200 - 500)
  "501-1000"    → Large (500 - 1000)
  "1001-5000"   → X-Large (1000 - 5000)
  "5001-10000"  → XX-Large (5000+)
  "10001+"      → XX-Large (5000+)

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
StartUp (<50):          $0.5M–$5M   | Small (50 - 200):       $5M–$30M
Medium (200 - 500):     $30M–$100M  | Large (500 - 1000):     $100M–$300M
X-Large (1000 - 5000):  $300M–$1B   | XX-Large (5000+):       $1B+
Adjust up for fintech/e-commerce, down for NGOs/nonprofits.

════════════════════════════════════════════════════════════
ACCOUNT TYPE REASON — Evidence-based, must include product/platform name
════════════════════════════════════════════════════════════
Always cite SPECIFIC signals in 1–2 sentences. ALWAYS mention the product or platform name or type:
  ISV: MUST name the specific proprietary product(s) or platform (e.g. "Briter Intelligence platform", "AgBase product"), mention subscription/licensing model, confirm independence. Format: "[Company] owns [Product Name], a [type of platform] offering [subscriptions/licensing] to [target customers]."
  Agency: specify the IT services offered (e.g. "app development, IT consulting"), confirm no proprietary product, mention client delivery model. Format: "[Company] provides [specific IT services] to clients with no proprietary software product."
  Enterprise: cite employee count or business lines + offline/own-product sales channel. Format: "[Company] operates [N+ employees / multiple business lines] with revenue primarily from [offline stores / direct sales / own product sales]."
  Consumer Portal: name the marketplace and its buyer-seller connection, confirm commission/ad/transaction revenue. Format: "[Company] operates a marketplace connecting [buyers] and [sellers], monetized via [commissions/ads/transactions]."
  PE/VC: confirm capital investment model and investment stage focus. Format: "[Company] is a [PE/VC] firm that invests capital in [stage] companies, not selling products or services."

════════════════════════════════════════════════════════════
CLOUD PLATFORM — Format with source
════════════════════════════════════════════════════════════
Format: "[Platform Name] | Source: [URL] ([source type])"

Source tiers in priority order:
  1. BuiltWith profile:   "AWS | Source: https://builtwith.com/website/company.com (BuiltWith)"
  2. Wappalyzer profile:  "GCP | Source: https://wappalyzer.com/technologies/company (Wappalyzer)"
  3. StackShare profile:  "Azure | Source: https://stackshare.io/company/stack (StackShare)"
  4. Company careers page: "AWS | Source: https://company.com/careers (Job posting mentions AWS)"
  5. Company tech blog:   "GCP | Source: https://engineering.company.com/post (Engineering blog)"
  6. If source NOT found: "[Platform] | Source: No verified source found (inferred from [specific reason e.g. Indian SaaS startup, Python/data stack, Microsoft stack job postings])"

⚠️ RULES:
  - If cloud evidence is provided in research context → use that platform and URL exactly
  - If a BuiltWith/Wappalyzer/StackShare URL is provided but no platform detected in its snippet → use that URL as the source with your best platform inference
  - NEVER use a URL belonging to a different company (e.g. Mitsui, Freshworks) as the source for another company
  - If no source found: write "No verified source found" — do NOT fabricate a URL

════════════════════════════════════════════════════════════
OUTPUT — All 20 fields required. Return ONLY valid JSON.
════════════════════════════════════════════════════════════
{
  "accountName": "Official company name",
  "website": "Exact domain as provided — do NOT change it",
  "draInsights": "2–3 sentences: what company does, business model, key products/services, market position",
  "engineeringIT": "[Tech Stack] | Team Size: [n or range]",
  "cloudPlatform": "[Platform Name] | Source: [URL or 'Inferred from [reason]']",
  "devOps": "[Tools & Practices] | Team Size: [n or range]",
  "employeeCount": "LinkedIn range if available, else estimated range",
  "accountTypeBySize": "StartUp (<50) | Small (50 - 200) | Medium (200 - 500) | Large (500 - 1000) | X-Large (1000 - 5000) | XX-Large (5000+)",
  "accountType": "Enterprise | ISV | Consumer Portal | Agency/Service Company | PE/VC Firms",
  "accountTypeReason": "1–2 sentences naming the specific product/platform and citing the revenue model and classification signal",
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

    // ── 4. Extract company name + search anchor from website ──
    // Always preserve the full domain for searching — never just use the slug alone
    // "blackbox.ai" → cleanDomain="blackbox.ai", companyName="blackbox", searchAnchor="blackbox.ai"
    // "briter.co"   → cleanDomain="briter.co",   companyName="briter",   searchAnchor="briter.co"
    const cleanDomain = website
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .toLowerCase();

    const companyName = cleanDomain
      .split(".")[0]
      .replace(/-/g, " ")
      .trim();

    // searchAnchor: always prefer full domain over bare slug to avoid ambiguity
    // e.g. "blackbox.ai" not "blackbox" (which would match blackbox.com)
    const searchAnchor = cleanDomain; // e.g. "blackbox.ai", "briter.co", "tripjack.com"

    // ── 5. Parallel: Search LinkedIn URL + Company Info + Cloud Platform ─────
    let linkedInUrl = "";
    let linkedInData: LinkedInData = { employeeCount: "", employeeRange: "", hqLocation: "", founded: "", industry: "", companyType: "", website: "", about: "", engineeringTeamSize: "", devOpsTeamSize: "" };
    let webSearchContext = "";
    let cloudEvidence: CloudEvidence = { platform: "", sourceUrl: "", snippet: "" };

    if (serperKey) {
      console.log("Running web search for:", website);
      try {
        const [liUrl, webCtx, cloudEv] = await Promise.all([
          findLinkedInUrl(companyName, searchAnchor, serperKey),
          searchCompanyInfo(companyName, searchAnchor, serperKey),
          searchCloudPlatform(companyName, searchAnchor, serperKey),
        ]);
        linkedInUrl = liUrl;
        webSearchContext = webCtx;
        cloudEvidence = cloudEv;
        console.log("LinkedIn URL found:", linkedInUrl || "none");
        console.log("Web context length:", webSearchContext.length);
        console.log("Cloud evidence:", JSON.stringify(cloudEvidence));

        if (linkedInUrl) {
          linkedInData = await scrapeLinkedIn(linkedInUrl);
          console.log("LinkedIn data:", JSON.stringify(linkedInData));
        }
      } catch (searchErr) {
        console.log("Web search failed (possibly quota exhausted) — using Groq knowledge only:", searchErr);
        linkedInUrl = "";
        webSearchContext = "";
        cloudEvidence = { platform: "", sourceUrl: "", snippet: "" };
      }
    } else {
      console.log("No Serper key configured — using Groq knowledge only");
    }

    // ── 6. Build research context for AI ───────────────────
    const cloudEvidenceLine = cloudEvidence.platform
      ? `Cloud Platform Found: ${cloudEvidence.platform}${cloudEvidence.sourceUrl ? ` | Source URL: ${cloudEvidence.sourceUrl}` : ""}${cloudEvidence.snippet ? ` | Evidence: "${cloudEvidence.snippet.slice(0, 200)}"` : ""}`
      : "";

    const researchContext = [
      linkedInUrl ? `LinkedIn URL: ${linkedInUrl}` : "",
      linkedInData.employeeRange ? `LinkedIn Employee Range: ${linkedInData.employeeRange} employees` : "",
      linkedInData.employeeCount ? `LinkedIn Staff Count: ${linkedInData.employeeCount}` : "",
      linkedInData.engineeringTeamSize ? `LinkedIn Engineering/Tech Team Size: ${linkedInData.engineeringTeamSize} (use in engineeringIT field)` : "",
      linkedInData.devOpsTeamSize ? `LinkedIn DevOps/Infrastructure Team Size: ${linkedInData.devOpsTeamSize} (use in devOps field)` : "",
      linkedInData.hqLocation ? `LinkedIn HQ Location: ${linkedInData.hqLocation}` : "",
      linkedInData.founded ? `Founded: ${linkedInData.founded}` : "",
      linkedInData.about ? `LinkedIn About: ${linkedInData.about}` : "",
      cloudEvidenceLine,
      webSearchContext ? `\nWeb Search Results:\n${webSearchContext}` : "",
    ].filter(Boolean).join("\n");

    // ── 7. Call Groq ────────────────────────────────────────
    const looksLikeDomain = website.includes('.');
    const userMessage = `Research this company and return the complete 20-field JSON profile.

${looksLikeDomain
  ? `Website: ${website}
⚠️ DOMAIN DISAMBIGUATION: The exact domain is "${cleanDomain}". This may differ from similarly-named companies on different TLDs (e.g. blackbox.ai is NOT blackbox.com — they are completely different companies). All research must be anchored to "${cleanDomain}" specifically.`
  : `Company Name: ${website}
Note: User typed the company name directly. Find the correct website domain and use it in the website field.`}
Company Name (extracted): ${companyName}

${researchContext ? `=== REAL DATA FROM WEB RESEARCH ===
${researchContext}

Use the above real data to fill fields accurately.
- All data above is anchored to "${cleanDomain}" — do not mix with data from other domains
- LinkedIn employee count is the most reliable signal for size classification
- LinkedIn HQ location overrides any inferred location
- LinkedIn About section helps determine account type and business model
${cloudEvidence.platform && cloudEvidence.sourceUrl
  ? `- ✅ Cloud Platform CONFIRMED: "${cloudEvidence.platform}" | Source: ${cloudEvidence.sourceUrl}. Use this exactly in cloudPlatform field.`
  : cloudEvidence.sourceUrl && !cloudEvidence.platform
  ? `- 🔍 Tech profile page found but cloud platform not detected in snippet: ${cloudEvidence.sourceUrl}. Infer the most likely platform from company type and use this URL as the source.`
  : `- ❌ No cloud source found via BuiltWith/Wappalyzer/StackShare/careers search. Infer the platform from company type/industry. Write: "[Platform] | Source: No verified source found (inferred from [specific reason])"`
}` : `No web search data available — use your full training knowledge.
Apply the complete knowledge base rules in your system prompt.
⚠️ Research must be specific to "${cleanDomain}" — not similarly named companies on other TLDs.
Make confident inferences based on domain TLD, company name, industry context.
Never return "Unknown" when inference is possible.`}

CLASSIFICATION REMINDERS — read carefully before classifying:
1. Order: PE/VC → ISV → Agency → Consumer Portal → Enterprise (default)
2. ⚠️ ISV BEFORE Agency: If company has ANY named proprietary platform/product with subscriptions → ISV, NOT Agency. Small size (even 10–50 employees) does NOT prevent ISV classification.
3. Data/intelligence/research platforms with their own product (like Briter Intelligence, Tracxn, Crunchbase) → ISV + Business Software/Internet (SaaS) + Data Management & Analytics
4. Non-IT service companies → Enterprise NOT Agency (e.g. logistics, real estate, accounting, law firms)
5. Company selling only its OWN products online → Enterprise NOT Consumer Portal
6. ISV must own a product AND be independent (not a subsidiary)
7. ⚠️ accountTypeReason MUST name the specific product or platform (e.g. "Briter Intelligence platform", "Zoho CRM", "their recruitment SaaS platform") — not just say "owns a software product"
8. ⚠️ cloudPlatform: if source URL confirmed above → use it exactly. If no source found → write "[Platform] | Source: No verified source found (inferred from [reason])". NEVER use a URL belonging to a different company.
9. For Indian companies: region=India (NOT APAC), timezone=IST/UTC+5:30
10. Always include team size estimates in both engineeringIT and devOps fields
11. The "website" field must be exactly: ${website}`;

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

    // ── 10. Hard-correct accountTypeBySize from employee count ─
    // Never trust the AI to map employee ranges to size tiers correctly.
    // Parse the actual employee count/range and enforce the correct tier.
    function resolveAccountSize(empStr: string): string {
      if (!empStr) return "";

      // Normalise: remove commas, extract all numbers
      const cleaned = empStr.replace(/,/g, "");

      // LinkedIn-style ranges: "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000"
      // Also handles "11–50", "11 - 50", "11 to 50"
      const rangeMatch = cleaned.match(/(\d+)\s*[-–to]+\s*(\d+)/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1]);
        const hi = parseInt(rangeMatch[2]);
        const mid = (lo + hi) / 2;
        return sizeFromCount(mid);
      }

      // Single number: "34 employees", "~500", "500+"
      const singleMatch = cleaned.match(/(\d+)/);
      if (singleMatch) {
        return sizeFromCount(parseInt(singleMatch[1]));
      }

      return "";
    }

    function sizeFromCount(n: number): string {
      if (n < 50)    return "StartUp (<50)";
      if (n < 200)   return "Small (50 - 200)";
      if (n < 500)   return "Medium (200 - 500)";
      if (n < 1000)  return "Large (500 - 1000)";
      if (n < 5000)  return "X-Large (1000 - 5000)";
      return "XX-Large (5000+)";
    }

    // Use LinkedIn data first (most accurate), then fall back to AI's employeeCount field
    const empSource = linkedInData.employeeCount || linkedInData.employeeRange || enriched.employeeCount || "";
    const correctedSize = resolveAccountSize(empSource);
    if (correctedSize) {
      enriched.accountTypeBySize = correctedSize;
      console.log(`accountTypeBySize corrected to: ${correctedSize} (from: "${empSource}")`);
    }

    // ── 11. Return ──────────────────────────────────────────
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